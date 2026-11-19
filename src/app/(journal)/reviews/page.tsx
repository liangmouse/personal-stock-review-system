import Link from "next/link";

import { formatDecimal, formatPrice, orderStatusLabels, sideLabels, statusTone } from "@/components/labels";
import { getDb } from "@/db/client";
import { listReviewOrders } from "@/lib/journal";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

function value(search: Search, key: string, fallback: string) {
  const raw = search[key];
  return typeof raw === "string" ? raw : fallback;
}

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  await requireSession();
  const search = await searchParams;
  const filter = value(search, "filter", "pending");
  const page = Number(value(search, "page", "1"));
  const result = await listReviewOrders(getDb(), {
    filter: ["pending", "all", "reviewed"].includes(filter) ? filter : "pending",
    page: String(Number.isSafeInteger(page) && page > 0 ? page : 1),
    page_size: "25",
  });
  const currentPage = result.page;

  function pageLink(nextPage: number) {
    const params = new URLSearchParams({
      filter: ["pending", "all", "reviewed"].includes(filter) ? filter : "pending",
      page: String(nextPage),
      page_size: "25",
    });
    return `/reviews?${params.toString()}`;
  }

  const tabs = [
    { key: "pending", label: "待复盘" },
    { key: "all", label: "全部订单" },
    { key: "reviewed", label: "已复盘" },
  ] as const;

  return (
    <div className="page-content">
      <section className="page-heading">
        <div>
          <p className="page-kicker">执行纪律</p>
          <h1>交易复盘</h1>
          <p className="page-intro">记录计划执行情况、偏差和下一次改进。</p>
        </div>
      </section>

      <section aria-label="复盘筛选" className="panel review-list-panel">
        <nav className="review-tabs" aria-label="订单复盘状态">
          {tabs.map((tab) => (
            <Link
              aria-current={filter === tab.key ? "page" : undefined}
              className={filter === tab.key ? "review-tab is-active" : "review-tab"}
              href={`/reviews?filter=${tab.key}`}
              key={tab.key}
            >
              {tab.label}
            </Link>
          ))}
          <span className="review-total">{result.total} 笔订单</span>
        </nav>

        {result.items.length === 0 ? (
          <div className="empty-state">
            <span aria-hidden="true" className="empty-symbol">▤</span>
            <h3>{filter === "pending" ? "暂时没有待复盘订单" : "没有符合条件的订单"}</h3>
            <p>{filter === "pending"
              ? "有订单记录后，可以在这里回顾执行过程。"
              : "切换筛选状态查看其他订单。"}</p>
          </div>
        ) : (
          <div className="review-order-list">
            {result.items.map((item) => (
              <article className="review-order-card" key={item.id}>
                <div className="review-order-main">
                  <div className="review-order-heading">
                    <Link className="review-symbol" href={`/orders/${item.id}`}>{item.symbol}</Link>
                    <span className={`status-pill tone-${statusTone(item.status)}`}>
                      {orderStatusLabels[item.status] ?? item.status}
                    </span>
                  </div>
                  <p className="review-order-summary">
                    {sideLabels[item.side] ?? item.side}
                    {item.quantity ? ` · 委托 ${formatDecimal(item.quantity)} 股` : " · 委托数量未知"}
                    {item.limit_price ? ` · 限价 ${formatPrice(item.limit_price)}` : ""}
                  </p>
                  {item.review?.execution_review && (
                    <p className="review-order-excerpt">{item.review.execution_review}</p>
                  )}
                  {item.review && (
                    <span className="review-version">复盘版本 {item.review.version}</span>
                  )}
                </div>
                <div className="review-order-actions">
                  <span className={item.review ? "review-complete-label" : "review-pending-label"}>
                    <span aria-hidden="true" className="event-mini-dot" />
                    {item.review ? "已完成复盘" : "待复盘"}
                  </span>
                  <Link
                    className={item.review ? "button button-secondary" : "button button-primary"}
                    href={"/orders/" + item.id + "/review"}
                  >
                    {item.review ? "查看复盘" : "开始复盘"}
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="pagination">
          <span>第 {currentPage} 页 · {result.total} 条记录</span>
          <div className="pagination-actions">
            {currentPage > 1
              ? <Link className="page-button" href={pageLink(currentPage - 1)}>上一页</Link>
              : <span className="page-button is-disabled">上一页</span>}
            {currentPage * result.page_size < result.total
              ? <Link className="page-button" href={pageLink(currentPage + 1)}>下一页</Link>
              : <span className="page-button is-disabled">下一页</span>}
          </div>
        </div>
      </section>
    </div>
  );
}
