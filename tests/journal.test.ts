import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "../src/db/schema";
import {
  getDashboard,
  getReview,
  listActivity,
  listReviewOrders,
  writeReview,
} from "../src/lib/journal";
import { JournalError, writeOrder } from "../src/lib/orders";
import { startTestDatabase } from "./helper";

type Database = NodePgDatabase<typeof schema>;

let db: Database;
let closeDatabase: (() => Promise<void>) | undefined;

async function createOrder(input: {
  symbol?: string;
  side?: "BUY" | "SELL";
  quantity?: string;
  occurred_at?: string;
}) {
  const idempotencyKey = randomUUID();
  return writeOrder(db, {
    kind: "create",
    body: {
      symbol: input.symbol ?? "DEMO",
      side: input.side ?? "BUY",
      order_type: "LIMIT",
      limit_price: "12.50",
      quantity: input.quantity ?? "2",
      occurred_at: input.occurred_at,
      idempotency_key: idempotencyKey,
    },
  });
}

function reviewCommand(
  orderId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    order_id: orderId,
    idempotency_key: randomUUID(),
    expected_version: 0,
    pre_trade_plan: "Follow the written entry plan.",
    followed_plan: true,
    execution_review: null,
    deviations: null,
    lessons: "Keep the order notes concise.",
    ...overrides,
  };
}

before(async () => {
  const testDatabase = await startTestDatabase();
  db = testDatabase.db;
  closeDatabase = testDatabase.close;
});

after(async () => {
  await closeDatabase?.();
});

test("dashboard aggregates orders and events, counts pending reviews, and caps recent events at six", async () => {
  const beforeDashboard = await getDashboard(db);
  const orders = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      createOrder({ symbol: `DEMO${index}`, quantity: "2" }),
    ),
  );
  await Promise.all(
    orders.slice(0, 3).map(({ order_id }) =>
      writeOrder(db, {
        kind: "fill",
        orderId: order_id,
        body: {
          price: "12.45",
          quantity: "1",
          idempotency_key: randomUUID(),
        },
      }),
    ),
  );

  await writeReview(db, reviewCommand(orders[0]!.order_id));

  const dashboard = await getDashboard(db);
  assert.equal(dashboard.event_count, beforeDashboard.event_count + 7);
  assert.equal(dashboard.open_order_count, beforeDashboard.open_order_count + 4);
  assert.equal(
    dashboard.pending_review_count,
    beforeDashboard.pending_review_count + 3,
  );
  assert.equal(dashboard.recent_events.length, 6);
  assert.ok(dashboard.recent_events.every((event) => event.recorded_at !== null));
  assert.deepEqual(
    dashboard.recent_events.map((event) => event.event_type).filter((type) => type === "FILLED").length,
    3,
  );
});

test("activity filters event and order fields with inclusive Shanghai calendar dates", async () => {
  const lateOrder = await createOrder({
    symbol: "DEMO-A",
    side: "BUY",
    occurred_at: "2001-02-03T15:59:59Z",
  });
  const firstMoment = await createOrder({
    symbol: "DEMO-B",
    side: "SELL",
    occurred_at: "2001-02-03T16:00:00Z",
  });
  const nextDay = await createOrder({
    symbol: "DEMO-C",
    side: "BUY",
    occurred_at: "2001-02-04T16:00:00Z",
  });

  const page = await listActivity(db, {
    from: "2001-02-04",
    to: "2001-02-04",
    side: "SELL",
    status: "OPEN",
    event_type: "SUBMITTED",
    page: "1",
    page_size: "10",
  });
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.order_id, firstMoment.order_id);

  const symbolPage = await listActivity(db, {
    symbol: "demo-c",
    event_type: "SUBMITTED",
  });
  assert.equal(symbolPage.items[0]?.order_id, nextDay.order_id);

  const beforeStart = await listActivity(db, {
    from: "2001-02-04",
    to: "2001-02-04",
    symbol: "DEMO-A",
  });
  assert.equal(beforeStart.total, 0);
  assert.notEqual(lateOrder.order_id, firstMoment.order_id);
});

test("activity date filters omit events without an actual occurred_at", async () => {
  const unknownTimeOrder = await createOrder({ symbol: "DEMO-TIME" });
  const withoutDates = await listActivity(db, { symbol: "DEMO-TIME" });
  assert.equal(withoutDates.total, 1);

  const withDates = await listActivity(db, {
    symbol: "DEMO-TIME",
    from: "2000-01-01",
    to: "2100-01-01",
  });
  assert.equal(withDates.total, 0);
  assert.equal(withoutDates.items[0]?.order_id, unknownTimeOrder.order_id);
});

test("review lists distinguish pending, reviewed, and all orders", async () => {
  const pending = await createOrder({ symbol: "DEMO-PENDING" });
  const reviewed = await createOrder({ symbol: "DEMO-REVIEWED" });
  await writeReview(db, reviewCommand(reviewed.order_id));

  const pendingResult = await listReviewOrders(db, { filter: "pending" });
  const reviewedResult = await listReviewOrders(db, { filter: "reviewed" });
  const allResult = await listReviewOrders(db, { filter: "all" });

  assert.ok(pendingResult.items.some((item) => item.id === pending.order_id));
  assert.ok(
    !pendingResult.items.some((item) => item.id === reviewed.order_id),
  );
  assert.ok(reviewedResult.items.some((item) => item.id === reviewed.order_id));
  assert.ok(allResult.items.some((item) => item.id === pending.order_id));
  assert.ok(allResult.items.some((item) => item.id === reviewed.order_id));

  const fetchedReview = await getReview(db, reviewed.order_id);
  assert.equal(fetchedReview.review?.order_id, reviewed.order_id);
  assert.equal(fetchedReview.review?.version, 1);
  assert.equal((await getReview(db, pending.order_id)).review, null);
  await assert.rejects(
    () => getReview(db, randomUUID()),
    (error: unknown) =>
      error instanceof JournalError && error.code === "ORDER_NOT_FOUND",
  );
});

test("review saves use optimistic versions and replay old idempotency receipts without overwriting newer content", async () => {
  const order = await createOrder({ symbol: "DEMO-IDEMPOTENCY" });
  const firstRequest = reviewCommand(order.order_id, {
    idempotency_key: "review-first-save",
    pre_trade_plan: "First saved plan.",
    expected_version: 0,
  });
  const first = await writeReview(db, firstRequest);
  assert.equal(first.version, 1);
  assert.equal(first.replayed, false);

  const second = await writeReview(
    db,
    reviewCommand(order.order_id, {
      idempotency_key: "review-second-save",
      pre_trade_plan: "Second saved plan.",
      expected_version: 1,
    }),
  );
  assert.equal(second.version, 2);
  assert.equal(second.replayed, false);

  const delayedRetry = await writeReview(db, firstRequest);
  assert.equal(delayedRetry.review_id, first.review_id);
  assert.equal(delayedRetry.version, 1);
  assert.equal(delayedRetry.replayed, true);

  const current = await getReview(db, order.order_id);
  assert.equal(current.review?.version, 2);
  assert.equal(current.review?.pre_trade_plan, "Second saved plan.");

  await assert.rejects(
    () =>
      writeReview(
        db,
        reviewCommand(order.order_id, {
          idempotency_key: "review-first-save",
          expected_version: 0,
          pre_trade_plan: "Changed after success.",
        }),
      ),
    (error: unknown) =>
      error instanceof JournalError &&
      error.code === "IDEMPOTENCY_KEY_REUSED",
  );

  await assert.rejects(
    () =>
      writeReview(
        db,
        reviewCommand(order.order_id, {
          idempotency_key: "review-stale-save",
          expected_version: 1,
        }),
      ),
    (error: unknown) =>
      error instanceof JournalError &&
      error.code === "REVIEW_VERSION_CONFLICT",
  );
});

test("review saves reject empty, malformed, and unknown input and serialize concurrent versions", async () => {
  const order = await createOrder({ symbol: "DEMO-CONCURRENT" });

  await assert.rejects(
    () =>
      writeReview(
        db,
        reviewCommand(order.order_id, {
          idempotency_key: "review-empty-save",
          pre_trade_plan: "  ",
          followed_plan: null,
          execution_review: null,
          deviations: null,
          lessons: null,
        }),
      ),
    (error: unknown) =>
      error instanceof JournalError && error.code === "INVALID_INPUT",
  );

  await assert.rejects(
    () =>
      writeReview(
        db,
        reviewCommand(order.order_id, {
          unexpected: "field",
        }),
      ),
    (error: unknown) =>
      error instanceof JournalError && error.code === "INVALID_INPUT",
  );

  const concurrent = await Promise.allSettled([
    writeReview(
      db,
      reviewCommand(order.order_id, {
        idempotency_key: "review-race-one",
      }),
    ),
    writeReview(
      db,
      reviewCommand(order.order_id, {
        idempotency_key: "review-race-two",
        pre_trade_plan: "Another plan.",
      }),
    ),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = concurrent.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(
    rejected.reason instanceof JournalError &&
      rejected.reason.code === "REVIEW_VERSION_CONFLICT",
  );
});

test("review write receipts cannot be modified or removed", async () => {
  const order = await createOrder({ symbol: "DEMO-RECEIPT" });
  const result = await writeReview(
    db,
    reviewCommand(order.order_id, { idempotency_key: "review-receipt-immutability" }),
  );
  const [receipt] = await db
    .select()
    .from(schema.reviewWriteReceipts)
    .where(eq(schema.reviewWriteReceipts.idempotencyKey, "review-receipt-immutability"));
  assert.ok(receipt);

  await assert.rejects(
    db
      .update(schema.reviewWriteReceipts)
      .set({ version: 99 })
      .where(eq(schema.reviewWriteReceipts.id, receipt!.id)),
  );
  await assert.rejects(
    db
      .delete(schema.reviewWriteReceipts)
      .where(eq(schema.reviewWriteReceipts.id, receipt!.id)),
  );
  await assert.rejects(
    db.execute(sql.raw("TRUNCATE TABLE review_write_receipts")),
  );
  assert.equal(result.version, 1);
});
