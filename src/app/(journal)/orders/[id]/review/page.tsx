import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";

import { formatDecimal, formatPrice, orderStatusLabels, sideLabels, statusTone } from "@/components/labels";
import { getDb } from "@/db/client";
import { getJournalOrderDetail } from "@/lib/journal";
import { JournalError } from "@/lib/orders";
import { requireSession } from "@/lib/session";
import { ReviewEditor } from "./review-editor";

export const dynamic = "force-dynamic";

export default async function OrderReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const db = getDb();
  let detail;
  try {
    detail = await getJournalOrderDetail(db, id);
  } catch (error) {
    if (error instanceof JournalError && error.status === 404) notFound();
    throw error;
  }
  const review = detail.review;
  const savedReviewId =
    typeof query.saved_review === "string" ? query.saved_review : null;
  const order = detail.order;

  return (
    <div className="page-content">
      <div className="back-link-row">
        <Link className="text-link" href={`/orders/${id}`}><span aria-hidden="true">←</span> 返回订单详情</Link>
      </div>
      <section className="page-heading review-heading">
        <div>
          <p className="page-kicker">执行纪律记录</p>
          <h1>{order.symbol} 交易复盘</h1>
          <p className="page-intro">
            {sideLabels[order.side] ?? order.side}
            {order.quantity ? ` · 委托 ${formatDecimal(order.quantity)} 股` : " · 委托数量未知"}
            {order.limit_price ? ` · 限价 ${formatPrice(order.limit_price)}` : ""}
          </p>
        </div>
        <span className={`status-pill tone-${statusTone(order.status)}`}>
          {orderStatusLabels[order.status] ?? order.status}
        </span>
      </section>
      <ReviewEditor
        idempotencyKey={randomUUID()}
        orderId={order.id}
        review={review}
        savedReviewId={savedReviewId}
      />
    </div>
  );
}
