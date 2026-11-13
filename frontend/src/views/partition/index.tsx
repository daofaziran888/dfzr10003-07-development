import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/partition'
const columns = [
  "配置编号",
  "表名称",
  "分区字段",
  "分区类型",
  "保留天数",
  "预建天数",
  "冷热分离",
  "存储路径",
  "生效时间"
]
const actions = [
  "提交审批",
  "发布配置",
  "停用配置"
]
const statuses = [
  "草稿",
  "待审批",
  "已生效",
  "已停用"
]
const stats = [
  {
    "label": "分区配置总数",
    "value": 0
  },
  {
    "label": "已生效配置",
    "value": 0
  },
  {
    "label": "待审批配置",
    "value": 0
  }
]

type Row = Record<string, any>

type PlanForm = {
  表名称: string
  配置编号: string
  分区字段: string
  预建天数: string
  保留天数: string
  冷热分离: string
  文件格式: string
  日增量GB: string
  基准日期: string
}

function judgeTag(value: string) {
  if (value === '可容纳') return <span className="tag ok">可容纳</span>
  if (value === '容量不足') return <span className="tag bad">容量不足</span>
  return <span className="tag warn">{value}</span>
}

export default function PartitionView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const [planForm, setPlanForm] = useState<PlanForm | null>(null)
  const [plan, setPlan] = useState<Row | null>(null)
  const [planMessage, setPlanMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    setErrorMessage('')
    const query = new URLSearchParams(filters).toString()
    try {
      const response = await request(`${ENDPOINT}?${query}`)
      if (!response.ok) {
        throw new Error('分区配置列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '分区策略列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    void reload()
  }, [reload])

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (!response.ok) {
        throw new Error('分区策略动作未生效，请稍后重试')
      }
      await reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '分区策略操作失败')
    }
  }

  function openPlanPanel(row: Row) {
    setPlan(null)
    setPlanMessage('')
    setPlanForm({
      表名称: String(row.表名称 ?? ''),
      配置编号: String(row.配置编号 ?? ''),
      分区字段: String(row.分区字段 ?? 'dt'),
      预建天数: String(row.预建天数 ?? '1'),
      保留天数: String(row.保留天数 ?? '30'),
      冷热分离: String(row.冷热分离 ?? '否'),
      文件格式: String(row.文件格式 ?? 'parquet'),
      日增量GB: '10',
      基准日期: '',
    })
  }

  async function submitPreview() {
    if (!planForm) return
    setBusy(true)
    setPlanMessage('')
    try {
      const response = await request(`${ENDPOINT}/plans/preview`, {
        method: 'POST',
        body: JSON.stringify({
          values: {
            ...planForm,
            预建天数: Number(planForm.预建天数),
            保留天数: Number(planForm.保留天数),
            日增量GB: Number(planForm.日增量GB),
          },
        }),
      })
      const payload = await response.json()
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message ?? payload.detail ?? '预览生成失败')
      }
      setPlan(payload.entry)
      setPlanMessage(payload.message ?? '')
    } catch (error) {
      setPlanMessage(error instanceof Error ? error.message : '预览生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function runPlan(action: 'execute' | 'resume') {
    if (!plan) return
    setBusy(true)
    try {
      const response = await request(`${ENDPOINT}/plans/${plan.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ values: {} }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.detail ?? '规划执行失败')
      }
      setPlan(payload.entry)
      setPlanMessage(payload.message ?? '')
    } catch (error) {
      setPlanMessage(error instanceof Error ? error.message : '规划执行失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="page" data-module="partition">
      <header className="page-head">
        <div>
          <h2>分区策略管理</h2>
          <p className="page-desc">维护分区配置的策略定义、保留周期与存储规划，为分区治理提供可审计的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('分区配置登记入口尚未接入审批流')}>
            登记分区配置
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出分区策略清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      {planForm && (
        <section className="plan-panel">
          <h3>分区规划预览 — {planForm.表名称}（{planForm.配置编号 || '未指定配置'}）</h3>
          <div className="filter-bar">
            <label className="filter-item">
              <span>分区字段</span>
              <input value={planForm.分区字段} onChange={(e) => setPlanForm({ ...planForm, 分区字段: e.target.value })} />
            </label>
            <label className="filter-item">
              <span>预建天数</span>
              <input type="number" min={0} value={planForm.预建天数} onChange={(e) => setPlanForm({ ...planForm, 预建天数: e.target.value })} />
            </label>
            <label className="filter-item">
              <span>保留天数</span>
              <input type="number" min={1} value={planForm.保留天数} onChange={(e) => setPlanForm({ ...planForm, 保留天数: e.target.value })} />
            </label>
            <label className="filter-item">
              <span>冷热分离</span>
              <select value={planForm.冷热分离} onChange={(e) => setPlanForm({ ...planForm, 冷热分离: e.target.value })}>
                <option value="是">是</option>
                <option value="否">否</option>
              </select>
            </label>
            <label className="filter-item">
              <span>文件格式</span>
              <select value={planForm.文件格式} onChange={(e) => setPlanForm({ ...planForm, 文件格式: e.target.value })}>
                <option value="parquet">parquet</option>
                <option value="orc">orc</option>
                <option value="avro">avro</option>
                <option value="json">json</option>
                <option value="text">text</option>
              </select>
            </label>
            <label className="filter-item">
              <span>日增量GB</span>
              <input type="number" min={0} step="0.5" value={planForm.日增量GB} onChange={(e) => setPlanForm({ ...planForm, 日增量GB: e.target.value })} />
            </label>
            <label className="filter-item">
              <span>基准日期（留空为今天）</span>
              <input type="date" value={planForm.基准日期} onChange={(e) => setPlanForm({ ...planForm, 基准日期: e.target.value })} />
            </label>
            <button className="btn primary" type="button" disabled={busy} onClick={() => void submitPreview()}>
              生成预览
            </button>
            <button className="btn ghost" type="button" onClick={() => { setPlanForm(null); setPlan(null); setPlanMessage('') }}>
              收起面板
            </button>
          </div>

          {plan && (
            <div className="plan-result">
              <p className="plan-note">{plan.口径说明}</p>
              <div className="stat-row">
                <article className="stat-card">
                  <span className="stat-label">规划单 / 状态</span>
                  <strong className="stat-value">{plan.计划编号} · {plan.status}</strong>
                </article>
                <article className="stat-card">
                  <span className="stat-label">预计增量</span>
                  <strong className="stat-value">{plan.预计增量GB} GB</strong>
                </article>
                <article className="stat-card">
                  <span className="stat-label">计划释放 / 保留中</span>
                  <strong className="stat-value">{plan.计划释放GB} / {plan.保留中GB} GB</strong>
                </article>
                <article className="stat-card">
                  <span className="stat-label">容量判定</span>
                  <strong className="stat-value">{plan.容量是否充足 ? '充足' : '不足'}</strong>
                </article>
              </div>

              <h4>待创建分区（{plan.待创建分区?.length ?? 0} 个）</h4>
              <table className="data-table">
                <thead>
                  <tr><th>分区键</th><th>层级</th><th>预计容量GB</th><th>目标节点</th><th>状态</th></tr>
                </thead>
                <tbody>
                  {(plan.待创建分区 ?? []).map((item: Row) => (
                    <tr key={item.分区键}>
                      <td>{item.分区键}</td>
                      <td>{item.层级}</td>
                      <td>{item.预计容量GB}</td>
                      <td>{item.目标节点 ?? '无可用节点'}</td>
                      <td>{item.状态}</td>
                    </tr>
                  ))}
                  {(plan.待创建分区 ?? []).length === 0 && (
                    <tr><td className="empty-state" colSpan={5}>预建天数为 0，没有待创建分区</td></tr>
                  )}
                </tbody>
              </table>

              <h4>候选湖节点</h4>
              <table className="data-table">
                <thead>
                  <tr><th>节点编号</th><th>层级</th><th>剩余容量GB</th><th>预计新建GB</th><th>迁入/迁出GB</th><th>计划释放GB</th><th>预计占用GB</th><th>判定</th><th>不可迁移原因</th></tr>
                </thead>
                <tbody>
                  {(plan.节点影响 ?? []).map((node: Row) => (
                    <tr key={node.节点编号}>
                      <td>{node.节点编号}</td>
                      <td>{node.节点层级}</td>
                      <td>{node.剩余容量GB}</td>
                      <td>{node.预计新建GB}</td>
                      <td>{node.计划迁入GB} / {node.计划迁出GB}</td>
                      <td>{node.计划释放GB}</td>
                      <td>{node.预计占用GB}</td>
                      <td>{judgeTag(node.判定)}</td>
                      <td>{node.不可迁移原因 || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {(plan.迁移计划 ?? []).length > 0 && (
                <>
                  <h4>冷热迁移计划</h4>
                  <table className="data-table">
                    <thead>
                      <tr><th>分区键</th><th>容量GB</th><th>源节点</th><th>目标节点</th><th>状态</th></tr>
                    </thead>
                    <tbody>
                      {plan.迁移计划.map((item: Row) => (
                        <tr key={item.分区键}>
                          <td>{item.分区键}</td>
                          <td>{item.容量GB}</td>
                          <td>{item.源节点}</td>
                          <td>{item.目标节点 ?? '无可用冷层节点'}</td>
                          <td>{item.状态}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <h4>会被释放的旧分区（仅预览，不会删除任何数据）</h4>
              <table className="data-table">
                <thead>
                  <tr><th>分区键</th><th>容量GB</th><th>所在节点</th><th>处置</th><th>原因</th></tr>
                </thead>
                <tbody>
                  {(plan.计划释放分区 ?? []).map((item: Row) => (
                    <tr key={item.分区键}>
                      <td>{item.分区键}</td>
                      <td>{item.容量GB}</td>
                      <td>{item.节点编号}</td>
                      <td>{item.处置 === '可释放' ? <span className="tag ok">可释放</span> : <span className="tag warn">保留</span>}</td>
                      <td>{item.原因}</td>
                    </tr>
                  ))}
                  {(plan.计划释放分区 ?? []).length === 0 && (
                    <tr><td className="empty-state" colSpan={5}>保留期内没有需要释放的旧分区</td></tr>
                  )}
                </tbody>
              </table>

              <div className="plan-actions">
                {plan.status !== '已完成' && (
                  <button className="btn primary" type="button" disabled={busy} onClick={() => void runPlan('execute')}>
                    确认执行（按分区键幂等创建）
                  </button>
                )}
                {plan.status === '部分完成' && (
                  <button className="btn" type="button" disabled={busy} onClick={() => void runPlan('resume')}>
                    从断点 {plan.断点分区} 继续
                  </button>
                )}
                {plan.status === '已完成' && <span className="tag ok">规划已执行完成</span>}
                {plan.失败原因 && <span className="error-text">失败原因：{plan.失败原因}</span>}
              </div>
            </div>
          )}
          {planMessage && <p className="plan-note">{planMessage}</p>}
        </section>
      )}

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td className="row-actions">
                <button className="link" type="button" onClick={() => openPlanPanel(row)}>
                  预览规划
                </button>
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 1}>暂无分区策略数据，可先登记分区配置</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条分区策略记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
