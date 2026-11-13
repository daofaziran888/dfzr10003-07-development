import { useCallback, useEffect, useMemo, useState } from 'react'

import { request } from '@/api/client'

const ENDPOINT = '/api/lake'
const columns = [
  "节点编号",
  "存储路径",
  "文件格式",
  "压缩方式",
  "总容量",
  "已用容量",
  "访问策略",
  "节点状态",
  "节点层级"
]
const actions = [
  "启动节点",
  "暂停节点",
  "归档节点"
]
const statuses = [
  "草稿",
  "运行中",
  "已暂停",
  "已归档"
]
const stats = [
  {
    "label": "湖存储节点总数",
    "value": 0
  },
  {
    "label": "运行中节点",
    "value": 0
  },
  {
    "label": "已暂停节点",
    "value": 0
  }
]

type Row = Record<string, any>

function judgeTag(value: string) {
  if (value === '可容纳') return <span className="tag ok">可容纳</span>
  if (value === '容量不足') return <span className="tag bad">容量不足</span>
  return <span className="tag warn">{value}</span>
}

export default function LakeView() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const [impact, setImpact] = useState<Row | null>(null)
  const [impactMessage, setImpactMessage] = useState('')

  const reload = useCallback(async () => {
    setErrorMessage('')
    const query = new URLSearchParams(filters).toString()
    try {
      const response = await request(`${ENDPOINT}?${query}`)
      if (!response.ok) {
        throw new Error('湖存储节点列表读取失败')
      }
      const payload = await response.json()
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据湖存储列表读取失败')
    }
  }, [filters])

  const reloadImpact = useCallback(async () => {
    setImpactMessage('')
    try {
      const response = await request(`${ENDPOINT}/plan-impact`)
      if (!response.ok) {
        throw new Error('分区规划容量视图读取失败')
      }
      setImpact(await response.json())
    } catch (error) {
      setImpactMessage(error instanceof Error ? error.message : '分区规划容量视图读取失败')
    }
  }, [])

  useEffect(() => {
    void reload()
    void reloadImpact()
  }, [reload, reloadImpact])

  async function runAction(action: string, row: Row) {
    setErrorMessage('')
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (!response.ok) {
        throw new Error('数据湖存储动作未生效，请稍后重试')
      }
      await reload()
      await reloadImpact()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据湖存储操作失败')
    }
  }

  const source = impact?.来源计划
  const migrations: Row[] = impact?.迁移计划 ?? []

  return (
    <section className="page" data-module="lake">
      <header className="page-head">
        <div>
          <h2>数据湖存储管理</h2>
          <p className="page-desc">维护数据湖存储节点的路径规划、格式选择与容量监控，为湖存储治理提供可审计的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('湖存储节点登记入口尚未接入审批流')}>
            登记湖存储节点
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出数据湖存储清单
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

      <section className="plan-panel">
        <h3>
          分区规划容量视图
          {source
            ? ` — 来源 ${source.计划编号}（${source.表名称}，${source.status}${source.断点分区 ? `，断点 ${source.断点分区}` : ''}）`
            : ' — 按各表已生效配置试算'}
        </h3>
        <p className="plan-note">
          本视图与分区策略页的预览/执行共用同一份计算：节点容量、预计增量、计划释放与不可迁移原因口径一致。
          {impact?.口径说明 ? ` ${impact.口径说明}` : ''}
        </p>
        <div className="page-actions" style={{ marginBottom: 10 }}>
          <button className="btn" type="button" onClick={() => void reloadImpact()}>刷新容量视图</button>
          {impactMessage && <span className="error-text">{impactMessage}</span>}
        </div>

        <h4>候选节点与预计占用</h4>
        <table className="data-table">
          <thead>
            <tr><th>节点编号</th><th>层级</th><th>节点状态</th><th>总容量GB</th><th>已用GB</th><th>剩余GB</th><th>预计新建GB</th><th>迁入/迁出GB</th><th>计划释放GB</th><th>预计占用GB</th><th>判定</th><th>不可迁移原因</th></tr>
          </thead>
          <tbody>
            {(impact?.节点影响 ?? []).map((node: Row) => (
              <tr key={node.节点编号}>
                <td>{node.节点编号}</td>
                <td>{node.节点层级}</td>
                <td>{node.节点状态}</td>
                <td>{node.总容量GB}</td>
                <td>{node.已用容量GB}</td>
                <td>{node.剩余容量GB}</td>
                <td>{node.预计新建GB}</td>
                <td>{node.计划迁入GB} / {node.计划迁出GB}</td>
                <td>{node.计划释放GB}</td>
                <td>{node.预计占用GB}</td>
                <td>{judgeTag(node.判定)}</td>
                <td>{node.不可迁移原因 || '—'}</td>
              </tr>
            ))}
            {(impact?.节点影响 ?? []).length === 0 && (
              <tr><td className="empty-state" colSpan={12}>暂无容量规划数据</td></tr>
            )}
          </tbody>
        </table>

        <h4>会被释放的旧分区（{impact?.计划释放分区?.length ?? 0} 个）</h4>
        <table className="data-table">
          <thead>
            <tr><th>分区键</th><th>容量GB</th><th>所在节点</th><th>处置</th><th>原因</th></tr>
          </thead>
          <tbody>
            {(impact?.计划释放分区 ?? []).map((item: Row) => (
              <tr key={item.分区键}>
                <td>{item.分区键}</td>
                <td>{item.容量GB}</td>
                <td>{item.节点编号}</td>
                <td>{item.处置 === '可释放' ? <span className="tag ok">可释放</span> : <span className="tag warn">保留</span>}</td>
                <td>{item.原因}</td>
              </tr>
            ))}
            {(impact?.计划释放分区 ?? []).length === 0 && (
              <tr><td className="empty-state" colSpan={5}>当前规划下没有待释放的旧分区</td></tr>
            )}
          </tbody>
        </table>

        {migrations.length > 0 && (
          <>
            <h4>冷热迁移计划</h4>
            <table className="data-table">
              <thead>
                <tr><th>分区键</th><th>容量GB</th><th>源节点</th><th>目标节点</th><th>状态</th></tr>
              </thead>
              <tbody>
                {migrations.map((item: Row) => (
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
      </section>

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
              <td className="empty-state" colSpan={columns.length + 1}>暂无数据湖存储数据，可先登记湖存储节点</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条数据湖存储记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
