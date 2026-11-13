"""分区规划共享计算：分区策略页与数据湖存储页的容量口径都从这一个模块出。

预览、执行、湖存储容量视图不允许各算各的——湖节点容量与分区释放量必须同源，
否则会出现"分区页显示可迁移、湖存储页仍判定爆满"的口径打架。
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from app.store import store

# 文件格式相对原始日增量的存储系数（压缩后）
FORMAT_FACTOR = {
    "parquet": 0.4,
    "orc": 0.45,
    "avro": 0.6,
    "json": 0.9,
    "text": 1.0,
    "csv": 1.0,
}
DEFAULT_FORMAT = "parquet"
DEFAULT_DAILY_GB = 10.0
DEFAULT_RETENTION_DAYS = 30
HOT_DAYS = 7  # 冷热分离开启后，热层只保留最近 7 天，超出即迁往冷层
COLD_FACTOR = 0.6  # 冷层高压缩/纠删码带来的容量系数


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def to_int(value: Any, default: int) -> int:
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def to_date(value: Any, default: date) -> date:
    try:
        return date.fromisoformat(str(value).strip())
    except (TypeError, ValueError):
        return default


def _explicit(values: dict[str, Any], key: str) -> Any:
    """只把真正填了内容的字段当作显式参数，空字符串不算。"""
    raw = values.get(key)
    if raw is None:
        return None
    if isinstance(raw, str) and not raw.strip():
        return None
    return raw


def resolve_base_config(
    table: str, config_code: Any = None
) -> tuple[dict[str, Any], dict[str, Any] | None, str]:
    """同表配置冲突时：以已生效且生效时间更晚的配置为准。

    返回（基准配置, 请求配置, 口径说明）。请求配置未生效（如待审批的 PART-0002）
    时回落到已生效配置，并在口径说明里写清楚，避免负责人误以为按新方案算了。
    """
    rows = [row for row in store.rows("partition") if row.get("表名称") == table]
    code = str(config_code or "").strip()
    requested = next((row for row in rows if row.get("配置编号") == code), None) if code else None
    effective = [row for row in rows if row.get("status") == "已生效"]
    if effective:
        chosen = max(effective, key=lambda row: str(row.get("生效时间") or ""))
        if requested and requested.get("配置编号") != chosen.get("配置编号"):
            note = (
                f"配置 {requested.get('配置编号')} 当前为「{requested.get('status')}」，未生效；"
                f"按规则以同表已生效且生效时间更晚的 {chosen.get('配置编号')}"
                f"（生效时间 {chosen.get('生效时间') or '未登记'}）为准，"
                f"本次显式传入的参数仍会覆盖该配置的默认值。"
            )
        else:
            note = (
                f"按同表已生效且生效时间更晚的配置 {chosen.get('配置编号')}"
                f"（生效时间 {chosen.get('生效时间') or '未登记'}）计算。"
            )
        return chosen, requested, note
    if requested is not None:
        note = (
            f"该表暂无已生效配置，按请求配置 {requested.get('配置编号')}"
            f"（{requested.get('status')}）试算，结果仅供参考。"
        )
        return requested, requested, note
    return {}, None, "该表暂无已生效分区配置，按请求参数试算。"


def compute_plan(values: dict[str, Any]) -> dict[str, Any]:
    """根据分区字段、预建天数、保留天数、冷热分离和文件格式算一份完整规划。

    返回待创建分区、冷热迁移计划、计划释放分区与逐节点容量影响；
    分区页预览、执行前重算、湖存储页容量视图都调用这里。
    """
    table = str(values.get("表名称") or "").strip()
    base_config, requested_config, note = resolve_base_config(table, values.get("配置编号"))

    def pick(key: str, default: Any) -> Any:
        explicit = _explicit(values, key)
        if explicit is not None:
            return explicit
        fallback = base_config.get(key)
        if fallback is not None and str(fallback).strip() != "":
            return fallback
        return default

    partition_field = str(pick("分区字段", "dt"))
    precreate_days = max(to_int(pick("预建天数", 1), 1), 0)
    retention_days = max(to_int(pick("保留天数", DEFAULT_RETENTION_DAYS), DEFAULT_RETENTION_DAYS), 1)
    hot_cold = str(pick("冷热分离", "否")).strip() == "是"
    file_format = str(pick("文件格式", DEFAULT_FORMAT)).strip().lower()
    daily_gb = to_float(pick("日增量GB", DEFAULT_DAILY_GB), DEFAULT_DAILY_GB)
    base_date = to_date(pick("基准日期", None), date.today())

    factor = FORMAT_FACTOR.get(file_format, 1.0)
    per_partition_gb = round(daily_gb * factor, 2)

    items = [row for row in store.rows("partition_items") if row.get("表名称") == table]
    existing_keys = {str(row.get("分区键")) for row in items}
    nodes = store.rows("lake")

    def candidate_node(layer: str) -> dict[str, Any] | None:
        pool = [
            node
            for node in nodes
            if node.get("status") == "运行中" and node.get("节点层级") == layer
        ]
        if not pool:
            return None
        return max(
            pool,
            key=lambda node: to_float(node.get("总容量")) - to_float(node.get("已用容量")),
        )

    # 1) 待创建分区：从基准日期的下一天开始预建，新分区一律先落热层。
    to_create: list[dict[str, Any]] = []
    for offset in range(1, precreate_days + 1):
        day = base_date + timedelta(days=offset)
        key = f"{partition_field}={day.isoformat()}"
        node = candidate_node("热层")
        to_create.append(
            {
                "分区键": key,
                "分区日期": day.isoformat(),
                "层级": "热层",
                "预计容量GB": per_partition_gb,
                "目标节点": node.get("节点编号") if node else None,
                "状态": "已存在" if key in existing_keys else "待建",
            }
        )

    # 2) 冷热迁移：开启冷热分离后，热层中超过热层窗口的分区迁往冷层。
    migrations: list[dict[str, Any]] = []
    if hot_cold:
        hot_deadline = base_date - timedelta(days=HOT_DAYS)
        cold_node = candidate_node("冷层")
        for row in items:
            if row.get("层级") != "热层":
                continue
            if to_date(row.get("分区日期"), base_date) < hot_deadline:
                migrations.append(
                    {
                        "分区键": row.get("分区键"),
                        "容量GB": round(to_float(row.get("容量GB")), 2),
                        "源节点": row.get("节点编号"),
                        "目标节点": cold_node.get("节点编号") if cold_node else None,
                        "状态": "待迁移",
                    }
                )

    # 3) 计划释放：超过保留期的旧分区；容量与释放口径冲突时，
    #    优先保留仍有运行中读取的分区，宁可少释放也不误删在用的数据。
    retention_deadline = base_date - timedelta(days=retention_days)
    releases: list[dict[str, Any]] = []
    for row in items:
        if to_date(row.get("分区日期"), base_date) >= retention_deadline:
            continue
        reading = str(row.get("读取状态") or "") == "运行中"
        releases.append(
            {
                "分区键": row.get("分区键"),
                "分区日期": row.get("分区日期"),
                "容量GB": round(to_float(row.get("容量GB")), 2),
                "节点编号": row.get("节点编号"),
                "处置": "保留" if reading else "可释放",
                "原因": "仍有运行中读取，容量与释放口径冲突时优先保留"
                if reading
                else "已超过保留天数",
            }
        )

    # 4) 节点影响：新建、迁入迁出、释放汇总到同一张节点账上，
    #    分区页与湖存储页看到的必须是这同一份数字。
    impact: dict[str, dict[str, Any]] = {}
    for node in nodes:
        code = str(node.get("节点编号"))
        total = to_float(node.get("总容量"))
        used = to_float(node.get("已用容量"))
        impact[code] = {
            "节点编号": code,
            "节点层级": node.get("节点层级"),
            "节点状态": node.get("status"),
            "总容量GB": round(total, 2),
            "已用容量GB": round(used, 2),
            "剩余容量GB": round(total - used, 2),
            "预计新建GB": 0.0,
            "计划迁入GB": 0.0,
            "计划迁出GB": 0.0,
            "计划释放GB": 0.0,
        }
    for part in to_create:
        target = part.get("目标节点")
        if part["状态"] == "待建" and target in impact:
            impact[target]["预计新建GB"] += part["预计容量GB"]
    for migration in migrations:
        source = migration.get("源节点")
        target = migration.get("目标节点")
        if source in impact:
            impact[source]["计划迁出GB"] += migration["容量GB"]
        if target in impact:
            impact[target]["计划迁入GB"] += round(migration["容量GB"] * COLD_FACTOR, 2)
    for release in releases:
        code = release.get("节点编号")
        if release["处置"] == "可释放" and code in impact:
            impact[code]["计划释放GB"] += release["容量GB"]

    node_views: list[dict[str, Any]] = []
    for view in impact.values():
        projected = (
            view["已用容量GB"]
            + view["预计新建GB"]
            + view["计划迁入GB"]
            - view["计划迁出GB"]
            - view["计划释放GB"]
        )
        for key in ("预计新建GB", "计划迁入GB", "计划迁出GB", "计划释放GB"):
            view[key] = round(view[key], 2)
        view["预计占用GB"] = round(max(projected, 0.0), 2)
        if view["节点状态"] != "运行中":
            view["判定"] = "不可迁移"
            view["不可迁移原因"] = f"节点{view['节点状态']}，不可作为新建或迁移目标"
        elif view["预计新建GB"] > view["剩余容量GB"]:
            view["判定"] = "容量不足"
            view["不可迁移原因"] = (
                f"剩余 {view['剩余容量GB']}GB 不足以容纳预计新建 "
                f"{view['预计新建GB']}GB（执行口径不预扣释放量）"
            )
        elif view["预计占用GB"] > view["总容量GB"]:
            view["判定"] = "容量不足"
            view["不可迁移原因"] = (
                f"规划口径预计占用 {view['预计占用GB']}GB 超出总容量 {view['总容量GB']}GB"
            )
        else:
            view["判定"] = "可容纳"
            view["不可迁移原因"] = ""
        node_views.append(view)

    total_new = round(
        sum(part["预计容量GB"] for part in to_create if part["状态"] == "待建"), 2
    )
    total_release = round(
        sum(rel["容量GB"] for rel in releases if rel["处置"] == "可释放"), 2
    )
    total_kept = round(
        sum(rel["容量GB"] for rel in releases if rel["处置"] == "保留"), 2
    )
    capacity_enough = all(view["判定"] != "容量不足" for view in node_views) and all(
        part.get("目标节点") for part in to_create if part["状态"] == "待建"
    )

    return {
        "表名称": table,
        "基准日期": base_date.isoformat(),
        "采用配置编号": base_config.get("配置编号"),
        "请求配置编号": requested_config.get("配置编号") if requested_config else None,
        "口径说明": note,
        "参数": {
            "表名称": table,
            "配置编号": values.get("配置编号"),
            "分区字段": partition_field,
            "预建天数": precreate_days,
            "保留天数": retention_days,
            "冷热分离": "是" if hot_cold else "否",
            "文件格式": file_format,
            "日增量GB": daily_gb,
            "基准日期": base_date.isoformat(),
        },
        "待创建分区": to_create,
        "迁移计划": migrations,
        "计划释放分区": releases,
        "节点影响": node_views,
        "预计增量GB": total_new,
        "计划释放GB": total_release,
        "保留中GB": total_kept,
        "容量是否充足": capacity_enough,
    }
