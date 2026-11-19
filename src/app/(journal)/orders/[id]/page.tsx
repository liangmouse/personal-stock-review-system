import Link from "next/link";
import { notFound } from "next/navigation";

import { eventTone, eventTypeLabels, formatDateTime, formatDecimal, formatPrice, orderStatusLabels, sideLabels, statusTone } from "@/components/labels";
import { getDb } from "@/db/client";
import { getJournalOrderDetail, getReview } from "@/lib/journal";
import { JournalError } from "@/lib/orders";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const db = getDb();
  let detail;
  let reviewData;
  try {
    [detail, reviewData] = await Promise.all([
      getJournalOrderDetail(db, id),
      getReview(db, id),
    ]);
  } catch (error) {
    if (error instanceof JournalError && error.status === 404) notFound();
    throw error;
  }

  const { order, events } = detail;
  const review = reviewData.review;
  return (
    <div className="page-content">
      <div className="back-link-row">
        <Link className="text-link" href="/events"><span aria-hidden="true">←</span> 返回交易流水</Link>
      </div>

      <section className="page-heading order-heading">
        <div>
          <p className="page-kicker">订单详情</p>
          <div className="order-title-row">
            <h1>{order.symbol}</h1>
            <span className={`status-pill tone-${statusTone(order.status)}`}>
              {orderStatusLabels[order.status] ?? order.status}
            </span>
          </div>
          <p className="page-intro">
            {sideLabels[order.side] ?? order.side}
            {order.order_type ? ` · ${order.order_type === "LIMIT" ? "限价单" : "市价单"}` : " · 订单类型未知"}
            {order.quantity ? ` · 委托 ${formatDecimal(order.quantity)} 股` : " · 委托数量未知"}
          </p>
        </div>
        <Link className="button button-primary" href={"/orders/" + order.id + "/review"}>
          {review ? "查看并编辑复盘" : "填写交易复盘"}
        </Link>
      </section>

      <section aria-label="订单摘要" className="order-summary-grid">
        <div className="summary-item">
          <span>委托限价</span>
          <strong className="mono-cell">{order.limit_price ? formatPrice(order.limit_price) : "未记录"}</strong>
        </div>
        <div className="summary-item">
          <span>累计成交</span>
          <strong className="mono-cell">{formatDecimal(order.filled_quantity)} 股</strong>
        </div>
        <div className="summary-item">
          <span>创建记录于</span>
          <strong>{formatDateTime(order.created_at)}</strong>
        </div>
        <div className="summary-item">
          <span>订单 ID</span>
          <strong className="id-value" title={order.id}>{order.id}</strong>
        </div>
      </section>

      <section aria-labelledby="timeline-title" className="panel timeline-panel">
        <div className="panel-heading">
          <div>
            <h2 id="timeline-title">订单生命周期</h2>
            <p>事件顺序代表系统接收并记账的先后</p>
          </div>
          <span className="event-count">{events.length} 条事件</span>
        </div>

        {events.length === 0 ? (
          <div className="empty-state compact-empty">
            <h3>该订单还没有事件</h3>
          </div>
        ) : (
          <ol className="timeline-list">
            {events.map((event, index) => (
              <li className="timeline-item" key={event.id}>
                <span aria-hidden="true" className={`timeline-marker tone-${eventTone(event.event_type)}`}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="timeline-card">
                  <div className="timeline-card-heading">
                    <div>
                      <span className={`event-type-label tone-${eventTone(event.event_type)}`}>
                        <span aria-hidden="true" className="event-mini-dot" />
                        {eventTypeLabels[event.event_type] ?? event.event_type}
                      </span>
                    </div>
                    <span className="timeline-sequence">事件 {event.sequence}</span>
                  </div>
                  <p className="timeline-main">
                    {event.event_type === "SUBMITTED" && (
                      <>{event.price ? `限价 ${formatPrice(event.price)} · ` : ""}{event.quantity ? `委托 ${formatDecimal(event.quantity)} 股` : "数量未记录"}</>
                    )}
                    {event.event_type === "FILLED" && (
                      <>{event.price ? `成交价 ${formatPrice(event.price)} · ` : ""}{event.quantity ? `成交 ${formatDecimal(event.quantity)} 股` : "成交数量未记录"}</>
                    )}
                    {event.event_type === "CANCELLED" && (
                      <>{event.quantity ? `撤销剩余 ${formatDecimal(event.quantity)} 股` : "已撤销剩余委托，撤销数量未记录"}</>
                    )}
                  </p>
                  <div className="timeline-dates">
                    <span><small>实际发生</small>{event.occurred_at ? formatDateTime(event.occurred_at) : "未记录"}</span>
                    <span><small>系统记录</small>{formatDateTime(event.recorded_at)}</span>
                  </div>
                  {event.note && <p className="timeline-note">{event.note}</p>}
                  <details className="raw-event">
                    <summary>查看原始记录信息</summary>
                    <dl>
                      <div><dt>事件 ID</dt><dd>{event.id}</dd></div>
                      <div><dt>来源编号</dt><dd>{event.source_reference ?? "—"}</dd></div>
                      <div><dt>历史导入</dt><dd>{event.legacy_import ? "是" : "否"}</dd></div>
                      <div><dt>记录备注</dt><dd>{event.note ?? "—"}</dd></div>
                    </dl>
                  </details>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {review && (
        <section aria-labelledby="review-summary-title" className="panel detail-review-panel">
          <div className="panel-heading">
            <div>
              <h2 id="review-summary-title">交易复盘</h2>
              <p>执行纪律记录</p>
            </div>
            <Link className="text-link" href={`/orders/${order.id}/review`}>编辑复盘 <span aria-hidden="true">→</span></Link>
          </div>
          {review.execution_review && <p className="review-excerpt">{review.execution_review}</p>}
        </section>
      )}
    </div>
  );
}
