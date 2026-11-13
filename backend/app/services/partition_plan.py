"""分区规划单：预览落单、按分区键幂等创建、容量不足停在失败分区、断点续跑。

所有容量口径都来自 planning.compute_plan，本模块只负责状态流转与落账，
保证分区策略页与数据湖存储页看到的是同一份计算。
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.services import planning
from app.store import store

MODULE = "partition_plans"
ITEMS_MODULE = "partition_items"


class PartitionPlanService:
    def _next_code(self) -> str:
        rows = store.rows(MODULE)
        return f"PLAN-{len(rows) + 1:04d}"

    def preview(self, values: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
        """生成一次预览：只计算并登记规划单，不创建分区、不删除任何数据。"""
        if not str(values.get("表名称") or "").strip():
            return None, "缺少必填字段：表名称"
        computed = planning.compute_plan(values)
        rows = store.rows(MODULE)
        plan = {
            "id": max((int(row.get("id", 0)) for row in rows), default=0) + 1,
            "计划编号": self._next_code(),
            "status": "已预览",
            "pending": True,
            "abnormal": False,
            "断点分区": None,
            "失败原因": None,
            "创建时间": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            **computed,
        }
        rows.append(plan)
        return plan, "预览已生成：仅完成容量试算，未创建分区、未删除任何数据"

    def list_plans(self) -> list[dict[str, Any]]:
        return store.rows(MODULE)

    def get_plan(self, plan_id: int) -> dict[str, Any] | None:
        return store.find(MODULE, plan_id)

    def execute(
        self, plan_id: int, *, resumed: bool = False
    ) -> tuple[dict[str, Any] | None, str]:
        """按分区键幂等创建；容量不足停在失败分区并保留已完成部分。

        已存在的分区键一律跳过，重复执行或断点续跑都不会重复建满。
        """
        plan = store.find(MODULE, plan_id)
        if plan is None:
            return None, f"分区规划 {plan_id} 不存在或已归档"
        if plan.get("status") == "已完成":
            return plan, "规划单已完成，重复执行不会重复建分区"

        computed = planning.compute_plan(plan["参数"])
        items = store.rows(ITEMS_MODULE)
        existing = {
            str(row.get("分区键"))
            for row in items
            if row.get("表名称") == plan["表名称"]
        }
        created = 0
        skipped = 0
        failure: tuple[str, str] | None = None
        for part in computed["待创建分区"]:
            key = part["分区键"]
            if key in existing:
                part["状态"] = "已存在"
                skipped += 1
                continue
            node = next(
                (
                    row
                    for row in store.rows("lake")
                    if row.get("节点编号") == part.get("目标节点")
                ),
                None,
            )
            if node is None or node.get("status") != "运行中":
                failure = (key, f"目标节点 {part.get('目标节点') or '无'} 不可用")
                part["状态"] = "失败"
                break
            free = planning.to_float(node.get("总容量")) - planning.to_float(
                node.get("已用容量")
            )
            if free < part["预计容量GB"]:
                failure = (
                    key,
                    f"节点 {node.get('节点编号')} 剩余 {round(free, 2)}GB，"
                    f"不足本分区所需的 {part['预计容量GB']}GB",
                )
                part["状态"] = "失败"
                break
            items.append(
                {
                    "id": max((int(row.get("id", 0)) for row in items), default=0) + 1,
                    "status": "已建",
                    "pending": False,
                    "abnormal": False,
                    "表名称": plan["表名称"],
                    "分区键": key,
                    "分区日期": part["分区日期"],
                    "容量GB": part["预计容量GB"],
                    "层级": part["层级"],
                    "节点编号": node.get("节点编号"),
                    "读取状态": "空闲",
                }
            )
            node["已用容量"] = round(
                planning.to_float(node.get("已用容量")) + part["预计容量GB"], 2
            )
            existing.add(key)
            part["状态"] = "已建"
            created += 1

        plan["待创建分区"] = computed["待创建分区"]
        plan["迁移计划"] = computed["迁移计划"]
        plan["计划释放分区"] = computed["计划释放分区"]
        plan["节点影响"] = computed["节点影响"]
        plan["预计增量GB"] = computed["预计增量GB"]
        plan["计划释放GB"] = computed["计划释放GB"]
        plan["保留中GB"] = computed["保留中GB"]
        plan["容量是否充足"] = computed["容量是否充足"]
        if failure:
            plan["status"] = "部分完成"
            plan["断点分区"] = failure[0]
            plan["失败原因"] = failure[1]
            plan["abnormal"] = True
            message = (
                f"已在失败分区 {failure[0]} 停止：{failure[1]}；"
                f"本次新建 {created} 个、幂等跳过 {skipped} 个，"
                f"已完成部分已保留，可从断点继续"
            )
        else:
            plan["status"] = "已完成"
            plan["断点分区"] = None
            plan["失败原因"] = None
            plan["pending"] = False
            plan["abnormal"] = False
            message = f"规划执行完成：新建 {created} 个分区、幂等跳过 {skipped} 个"
        if resumed:
            message = f"从断点继续：{message}"
        return plan, message

    def lake_impact(self) -> dict[str, Any]:
        """湖存储页的容量规划视图：与分区策略页同一份计算，口径一致。"""
        rows = store.rows(MODULE)
        latest = rows[-1] if rows else None
        if latest is not None:
            computed = planning.compute_plan(latest["参数"])
            source = {
                "计划编号": latest["计划编号"],
                "表名称": latest["表名称"],
                "status": latest["status"],
                "断点分区": latest.get("断点分区"),
                "失败原因": latest.get("失败原因"),
            }
        else:
            table = ""
            for row in store.rows("partition"):
                if row.get("status") == "已生效":
                    table = str(row.get("表名称") or "")
                    break
            computed = planning.compute_plan({"表名称": table}) if table else None
            source = None
        if computed is None:
            return {"来源计划": None, "节点影响": [], "计划释放分区": [], "迁移计划": [], "待创建分区": []}
        return {"来源计划": source, **computed}
