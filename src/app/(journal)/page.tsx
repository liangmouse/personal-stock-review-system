import Link from "next/link";
import { McpConnection } from "@/components/mcp-connection";

import { eventTypeLabels, eventTone, formatDateTime, formatDecimal, formatPrice, orderStatusLabels, sideLabels, statusTone } from "@/components/labels";
import { getDb } from "@/db/client";
import { getDashboard } from "@/lib/journal";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requireSession();
  const dashboard = await getDashboard(getDb());

  return (
    <div className="page-content">
      <section className="page-heading dashboard-heading">
        <div>
          <h1>交易总览</h1>
          <p className="page-intro">订单状态、交易事件和待复盘记录。</p>
        </div>
        <McpConnection />
      </section>

      <section aria-label="交易记录概况" className="metric-grid">
        <article className="metric-card">
          <div className="metric-card-top">
            <span>交易事件</span>
            <span aria-hidden="true" className="metric-icon">↕</span>
          </div>
          <strong className="metric-value">{dashboard.event_count}</strong>
          <span className="metric-caption">挂单、成交与撤单记录</span>
        </article>
        <article className="metric-card">
          <div className="metric-card-top">
            <span>未完成订单</span>
            <span aria-hidden="true" className="metric-icon">◷</span>
          </div>
          <strong className="metric-value">{dashboard.open_order_count}</strong>
          <span className="metric-caption">等待后续成交或撤单</span>
        </article>
        <article className="metric-card metric-card-review">
          <div className="metric-card-top">
            <span>待复盘订单</span>
            <span aria-hidden="true" className="metric-icon">▤</span>
          </div>
          <strong className="metric-value">{dashboard.pending_review_count}</strong>
          <span className="metric-caption">尚未填写执行复盘</span>
          <Link className="metric-link" href="/reviews">打开复盘清单 <span aria-hidden="true">→</span></Link>
        </article>
      </section>

      <section aria-labelledby="recent-title" className="panel recent-panel">
        <div className="panel-heading">
          <div>
            <h2 id="recent-title">近期交易事件</h2>
            <p>按系统记录时间倒序排列</p>
          </div>
          <Link className="text-link" href="/events">全部流水 <span aria-hidden="true">→</span></Link>
        </div>

        {dashboard.recent_events.length === 0 ? (
          <div className="empty-state compact-empty">
            <span aria-hidden="true" className="empty-symbol">⌁</span>
            <h3>还没有交易事件</h3>
            <p>通过已连接的 Agent 记录第一笔委托后，即可在这里查看它的成交与撤单。</p>
          </div>
        ) : (
          <div className="recent-event-list">
            {dashboard.recent_events.map((event) => (
              <Link className="recent-event-row" href={`/orders/${event.order_id}`} key={event.id}>
                <span aria-hidden="true" className={`event-marker tone-${eventTone(event.event_type)}`} />
                <span className="recent-event-main">
                  <span className="recent-event-title">
                    <strong>{event.symbol}</strong>
                    <span>{eventTypeLabels[event.event_type] ?? event.event_type}</span>
                    <span className="side-label">{sideLabels[event.side] ?? event.side}</span>
                  </span>
                  <span className="recent-event-meta">
                    {event.occurred_at
                      ? `发生于 ${formatDateTime(event.occurred_at)}`
                      : `发生时间未记录 · 记录于 ${formatDateTime(event.recorded_at)}`}
                  </span>
                </span>
                <span className="recent-event-values">
                  <span>{event.price ? formatPrice(event.price) : "价格未记录"}</span>
                  <small>{event.quantity ? `${formatDecimal(event.quantity)} 股` : "数量未记录"}</small>
                </span>
                <span className={`status-pill tone-${statusTone(event.order_status)}`}>
                  {orderStatusLabels[event.order_status] ?? event.order_status}
                </span>
                <span aria-hidden="true" className="row-chevron">›</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
