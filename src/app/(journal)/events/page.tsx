import Link from "next/link";

import { Button } from "@/components/ui/button";
import { eventTone, eventTypeLabels, formatDateTime, formatDecimal, formatPrice, orderStatusLabels, sideLabels, statusTone } from "@/components/labels";
import { getDb } from "@/db/client";
import { listActivity } from "@/lib/journal";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

function queryValue(search: Search, key: string) {
  const value = search[key];
  return typeof value === "string" ? value : undefined;
}

export default async function EventsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireSession();
  const search = await searchParams;
  const symbol = queryValue(search, "symbol")?.trim();
  const side = queryValue(search, "side");
  const status = queryValue(search, "status");
  const eventType = queryValue(search, "event_type");
  const from = queryValue(search, "from");
  const to = queryValue(search, "to");
  const page = Number(queryValue(search, "page") ?? "1");
  const pageSize = 25;
  const params = new URLSearchParams();
  if (symbol) params.set("symbol", symbol);
  if (side) params.set("side", side);
  if (status) params.set("status", status);
  if (eventType) params.set("event_type", eventType);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const result = await listActivity(getDb(), {
    ...Object.fromEntries(params),
    page: String(Number.isSafeInteger(page) && page > 0 ? page : 1),
    page_size: String(pageSize),
  });
  const currentPage = result.page;
  function pageUrl(targetPage: number) {
    const nextParams = new URLSearchParams(params);
    nextParams.set("page", String(targetPage));
    return "/events?" + nextParams.toString();
  }
  const previousUrl = currentPage > 1 ? pageUrl(currentPage - 1) : null;
  const nextUrl = currentPage * result.page_size < result.total
    ? pageUrl(currentPage + 1)
    : null;

  return (
    <div className="page-content">
      <section className="page-heading">
        <div>
          <p className="page-kicker">订单生命周期</p>
          <h1>交易流水</h1>
          <p className="page-intro">每条记录对应一次挂单、成交或撤单。</p>
        </div>
      </section>

      <section aria-label="交易流水筛选" className="panel filter-panel">
        <form action="/events" className="filter-form" method="get">
          <label className="field">
            <span>标的</span>
            <input autoComplete="off" defaultValue={symbol ?? ""} name="symbol" placeholder="输入代码" />
          </label>
          <label className="field">
            <span>操作</span>
            <select defaultValue={eventType ?? ""} name="event_type">
              <option value="">全部操作</option>
              <option value="SUBMITTED">挂单</option>
              <option value="FILLED">成交</option>
              <option value="CANCELLED">撤单</option>
            </select>
          </label>
          <label className="field">
            <span>方向</span>
            <select defaultValue={side ?? ""} name="side">
              <option value="">全部方向</option>
              <option value="BUY">买入</option>
              <option value="SELL">卖出</option>
            </select>
          </label>
          <label className="field">
            <span>订单状态</span>
            <select defaultValue={status ?? ""} name="status">
              <option value="">全部状态</option>
              {Object.entries(orderStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>发生日期起</span>
            <input defaultValue={from ?? ""} name="from" type="date" />
          </label>
          <label className="field">
            <span>发生日期止</span>
            <input defaultValue={to ?? ""} name="to" type="date" />
          </label>
          <div className="filter-actions">
            <Button type="submit">筛选</Button>
            <Link className="clear-filter" href="/events">清除</Link>
          </div>
        </form>
      </section>

      <section aria-labelledby="events-title" className="panel table-panel">
        <div className="panel-heading">
          <div>
            <h2 id="events-title">全部事件</h2>
            <p>共 {result.total} 条 · 已知发生时间倒序，未记录时间置后</p>
          </div>
          <span className="table-caption">日期筛选依据实际发生时间</span>
        </div>

        {result.items.length === 0 ? (
          <div className="empty-state">
            <span aria-hidden="true" className="empty-symbol">⌁</span>
            <h3>没有匹配的交易事件</h3>
            <p>{result.total === 0 && !symbol && !side && !status && !eventType && !from && !to
              ? "订单产生事件后，记录会显示在这里。"
              : "试试调整标的、操作类型或日期范围。"}</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">交易时间 · 北京时间</th>
                  <th scope="col">标的</th>
                  <th scope="col">操作</th>
                  <th scope="col">方向</th>
                  <th className="number-cell" scope="col">价格</th>
                  <th className="number-cell" scope="col">数量</th>
                  <th scope="col">订单状态</th>
                  <th scope="col">备注</th>
                  <th scope="col"><span className="sr-only">详情</span></th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((event) => (
                  <tr key={event.id}>
                    <td>
                      <div className="time-cell">
                        <span>{event.occurred_at ? formatDateTime(event.occurred_at) : "未记录发生时间"}</span>
                        {!event.occurred_at && <small>记录于 {formatDateTime(event.recorded_at)}</small>}
                      </div>
                    </td>
                    <td><strong className="symbol-cell">{event.symbol}</strong></td>
                    <td>
                      <span className={`event-type-label tone-${eventTone(event.event_type)}`}>
                        <span aria-hidden="true" className="event-mini-dot" />
                        {eventTypeLabels[event.event_type] ?? event.event_type}
                      </span>
                    </td>
                    <td>{sideLabels[event.side] ?? event.side}</td>
                    <td className="number-cell mono-cell">{event.price ? formatPrice(event.price) : "—"}</td>
                    <td className="number-cell mono-cell">{event.quantity ? formatDecimal(event.quantity) : "—"}</td>
                    <td>
                      <span className={`status-pill tone-${statusTone(event.order_status)}`}>
                        {orderStatusLabels[event.order_status] ?? event.order_status}
                      </span>
                    </td>
                    <td className="note-cell" title={event.note ?? undefined}>{event.note || "—"}</td>
                    <td>
                      <Link aria-label={`查看 ${event.symbol} 订单`} className="icon-link" href={`/orders/${event.order_id}`}>
                        <span aria-hidden="true">↗</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="pagination">
          <span>第 {currentPage} 页 · {result.total} 条记录</span>
          <div className="pagination-actions">
            {previousUrl ? <Link className="page-button" href={previousUrl}>上一页</Link> : <span className="page-button is-disabled">上一页</span>}
            {nextUrl ? <Link className="page-button" href={nextUrl}>下一页</Link> : <span className="page-button is-disabled">下一页</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
