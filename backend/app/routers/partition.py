"""分区策略接口：维护分区配置，覆盖提交审批、发布配置、停用配置等动作。

另挂分区规划端点：预览只试算不动数据，执行按分区键幂等创建，
容量不足停在失败分区，之后可从断点继续。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query

from app.schemas import ActionResult, EntryPayload, PageResult
from app.services.partition import PartitionService
from app.services.partition_plan import PartitionPlanService

router = APIRouter(prefix="/api/partition", tags=["分区策略"])

service = PartitionService()
plan_service = PartitionPlanService()

LIST_FIELDS = ["配置编号", "表名称", "分区字段", "分区类型", "保留天数", "预建天数", "冷热分离", "存储路径", "生效时间"]
STATUSES = ["草稿", "待审批", "已生效", "已停用"]


@router.get("", response_model=PageResult[dict])
def list_entries(
    keyword: str | None = Query(default=None, description="按配置编号检索"),
    status: str | None = Query(default=None, description="草稿、待审批、已生效、已停用"),
    page: int = 1,
    size: int = 20,
) -> PageResult[dict]:
    """按配置编号与状态过滤分区策略列表；没有数据时返回空页，不报错。"""
    if size > 200:
        raise HTTPException(status_code=400, detail="每页最多 200 条，请缩小分页范围")
    items, total = service.list_entries(keyword=keyword, status=status, page=page, size=size)
    return PageResult(items=items, total=total, page=page, size=size)


@router.post("/plans/preview", response_model=ActionResult)
def preview_plan(payload: EntryPayload) -> ActionResult:
    """生成一次分区规划预览：按分区字段、预建天数、保留天数、冷热分离、文件格式
    试算待创建分区与湖容量占用；只登记规划单，不创建分区、不删除任何数据。"""
    plan, message = plan_service.preview(payload.values)
    if plan is None:
        return ActionResult(ok=False, message=message)
    return ActionResult(ok=True, message=message, entry=plan)


@router.get("/plans")
def list_plans() -> dict[str, Any]:
    """分区规划单列表：每次预览都会落一单，便于审计与断点续跑。"""
    plans = plan_service.list_plans()
    return {"module": "partition_plans", "total": len(plans), "items": plans}


@router.get("/plans/{plan_id}")
def get_plan(plan_id: int) -> dict[str, Any]:
    """读取单条分区规划明细；不存在时给出可读的错误说明。"""
    plan = plan_service.get_plan(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail=f"分区规划 {plan_id} 不存在或已归档")
    return plan


@router.post("/plans/{plan_id}/execute", response_model=ActionResult)
def execute_plan(plan_id: int) -> ActionResult:
    """确认执行：按分区键幂等创建；容量不足停在失败分区并保留已完成部分。"""
    plan, message = plan_service.execute(plan_id)
    if plan is None:
        return ActionResult(ok=False, message=message)
    return ActionResult(ok=plan.get("status") == "已完成", message=message, entry=plan)


@router.post("/plans/{plan_id}/resume", response_model=ActionResult)
def resume_plan(plan_id: int) -> ActionResult:
    """断点续跑：从上次失败分区继续，已建分区按分区键幂等跳过，不重复建满。"""
    plan, message = plan_service.execute(plan_id, resumed=True)
    if plan is None:
        return ActionResult(ok=False, message=message)
    return ActionResult(ok=plan.get("status") == "已完成", message=message, entry=plan)


@router.get("/{entry_id}", response_model=dict)
def get_entry(entry_id: int) -> dict:
    """读取单条分区配置明细；不存在时给出可读的错误说明。"""
    entry = service.get_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"分区配置 {entry_id} 不存在或已归档")
    return entry


@router.post("", response_model=ActionResult)
def create_entry(payload: EntryPayload) -> ActionResult:
    """登记一条分区配置，缺字段时说明原因而不是静默丢弃。"""
    entry, missing = service.create_entry(payload.values)
    if missing:
        return ActionResult(ok=False, message=f"缺少必填字段：{'、'.join(missing)}")
    return ActionResult(ok=True, message="分区配置已登记", entry=entry)


@router.post("/{entry_id}/actions", response_model=ActionResult)
def run_action(entry_id: int, payload: EntryPayload) -> ActionResult:
    """对单条分区配置执行提交审批、发布配置、停用配置；不允许的动作会被拦下并说明原因。"""
    action = str(payload.values.get("action") or "").strip()
    entry, message = service.run_action(entry_id, action)
    if entry is None:
        return ActionResult(ok=False, message=message)
    return ActionResult(ok=True, message=message, entry=entry)


@router.get("/export")
def export_entries() -> dict[str, Any]:
    """导出分区策略清单：返回当前过滤条件下的全量数据。"""
    items, total = service.list_entries(page=1, size=10000)
    return {"module": "partition", "total": total, "items": items}
