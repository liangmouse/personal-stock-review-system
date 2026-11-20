import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { orders, orderEvents, reviews, reviewWriteReceipts } from "../../src/db/schema";
import { writeReview } from "../../src/lib/journal";
import { writeOrder } from "../../src/lib/orders";

// Exercise the deployed database role, constraints, triggers and nested service
// transactions. The outer transaction is rolled back even when an assertion fails.
async function checkDatabase() {
  const db = getDb();
  const rollback = new Error("verification completed");
  let orderId = "";
  try {
    await db.transaction(async (tx) => {
      const command = {
        kind: "create" as const,
        body: { symbol: "DEMO-QA", side: "BUY", order_type: "LIMIT", limit_price: "12.50", quantity: "2", idempotency_key: randomUUID() },
      };
      const created = await writeOrder(tx, command);
      orderId = created.order_id;
      const replay = await writeOrder(tx, command);
      assert.equal(replay.event_id, created.event_id);
      assert.equal(replay.replayed, true);
      await writeOrder(tx, { kind: "fill", orderId, body: { price: "12.40", quantity: "1", idempotency_key: randomUUID() } });
      await writeOrder(tx, { kind: "cancel", orderId, body: { idempotency_key: randomUUID() } });
      const review = { order_id: orderId, expected_version: 0, idempotency_key: randomUUID(), lessons: "部署验收使用的虚构记录" };
      const saved = await writeReview(tx, review);
      const savedAgain = await writeReview(tx, review);
      assert.equal(savedAgain.review_id, saved.review_id);
      assert.equal(savedAgain.replayed, true);
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
      assert.equal(order.status, "CANCELLED");
      assert.equal(order.filledQuantity, "1.00000000");
      assert.equal(await tx.$count(orderEvents, eq(orderEvents.orderId, orderId)), 3);
      assert.equal(await tx.$count(reviewWriteReceipts, eq(reviewWriteReceipts.orderId, orderId)), 1);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  assert.equal(await db.$count(orders, eq(orders.id, orderId)), 0);
  assert.equal(await db.$count(orderEvents, eq(orderEvents.orderId, orderId)), 0);
  assert.equal(await db.$count(reviews, eq(reviews.orderId, orderId)), 0);
  assert.equal(await db.$count(reviewWriteReceipts, eq(reviewWriteReceipts.orderId, orderId)), 0);
  console.log("订单生命周期、复盘及重试回执已通过，验收事务已回滚。");
}
checkDatabase().then(() => process.exit(0)).catch(() => {
  console.error("数据库验收失败。请检查迁移、运行时角色授权与数据库连接。");
  process.exitCode = 1;
});
