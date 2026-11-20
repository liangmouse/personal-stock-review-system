import { createHash } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  gte,
  lt,
  sql,
} from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/db/schema";
import {
  cancelOrderInput,
  createOrderInput,
  listOrdersInput,
  orderIdInput,
  recordFillInput,
  type CancelOrderInput,
  type CreateOrderInput,
  type ListOrdersInput,
  type RecordFillInput,
} from "@/lib/input";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class JournalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JournalError";
  }
}

type WriteKind = "create" | "fill" | "cancel";

type WriteCommand = {
  kind: WriteKind;
  orderId?: string;
  body: unknown;
};

type WriteReceipt = {
  order_id: string;
  event_id: string;
  replayed: boolean;
};

type WriteIdentity = {
  idempotencyKey: string;
  requestHash: string;
};

type NormalizedWrite =
  | (WriteIdentity & {
      kind: "create";
      orderId: null;
      input: CreateOrderInput;
    })
  | (WriteIdentity & {
      kind: "fill";
      orderId: string;
      input: RecordFillInput;
    })
  | (WriteIdentity & {
      kind: "cancel";
      orderId: string;
      input: CancelOrderInput;
    });

const decimalScale = 100_000_000n;

function parseInput<T>(
  result: { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } },
): T {
  if (result.success) return result.data;
  const fields = result.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "body"} ${issue.message}`)
    .join("; ");
  throw new JournalError(400, "INVALID_INPUT", `请求字段无效：${fields}`);
}

function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * decimalScale + BigInt(fraction.padEnd(8, "0") || "0");
}

function nextSequence(value: string | number): number {
  const next = Number(value) + 1;
  if (!Number.isSafeInteger(next)) {
    throw new JournalError(409, "EVENT_SEQUENCE_EXHAUSTED", "订单事件序号已超出安全范围。");
  }
  return next;
}

function requestHash(kind: WriteKind, payload: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify({ kind, payload }))
    .digest("hex");
}

function normalizeWrite(command: WriteCommand): NormalizedWrite {
  if (command.kind === "create") {
    const parsed = parseInput(createOrderInput.safeParse(command.body));
    const payload = {
      symbol: parsed.symbol,
      side: parsed.side,
      order_type: parsed.order_type ?? null,
      limit_price: parsed.limit_price ?? null,
      quantity: parsed.quantity,
      occurred_at: parsed.occurred_at?.toISOString() ?? null,
      note: parsed.note,
    };
    return {
      kind: "create",
      orderId: null,
      idempotencyKey: parsed.idempotency_key,
      requestHash: requestHash("create", payload),
      input: parsed,
    };
  }

  const parsedOrderId = orderIdInput.safeParse(command.orderId);
  if (!parsedOrderId.success) {
    throw new JournalError(400, "INVALID_ORDER_ID", "必须提供有效的订单 ID。");
  }
  const orderId = parsedOrderId.data.toLowerCase();

  if (command.kind === "fill") {
    const parsed = parseInput(recordFillInput.safeParse(command.body));
    const payload = {
      order_id: orderId,
      price: parsed.price,
      quantity: parsed.quantity,
      occurred_at: parsed.occurred_at?.toISOString() ?? null,
      note: parsed.note,
    };
    return {
      kind: "fill",
      orderId,
      idempotencyKey: parsed.idempotency_key,
      requestHash: requestHash("fill", payload),
      input: parsed,
    };
  }

  if (command.kind === "cancel") {
    const parsed = parseInput(cancelOrderInput.safeParse(command.body));
    const payload = {
      order_id: orderId,
      cancelled_quantity: parsed.cancelled_quantity ?? null,
      occurred_at: parsed.occurred_at?.toISOString() ?? null,
      note: parsed.note,
    };
    return {
      kind: "cancel",
      orderId,
      idempotencyKey: parsed.idempotency_key,
      requestHash: requestHash("cancel", payload),
      input: parsed,
    };
  }

  throw new JournalError(400, "INVALID_OPERATION", "不支持的订单操作。");
}

async function lockIdempotencyKey(tx: Transaction, idempotencyKey: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`);
}

async function findReplay(
  tx: Transaction,
  write: NormalizedWrite,
): Promise<WriteReceipt | null> {
  const [existing] = await tx
    .select({
      id: schema.orderEvents.id,
      orderId: schema.orderEvents.orderId,
      requestHash: schema.orderEvents.requestHash,
    })
    .from(schema.orderEvents)
    .where(eq(schema.orderEvents.idempotencyKey, write.idempotencyKey))
    .limit(1);

  if (!existing) return null;
  if (existing.requestHash !== write.requestHash) {
    throw new JournalError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "该幂等键已用于不同请求，请核对交易内容后使用新的幂等键。",
    );
  }

  return {
    order_id: existing.orderId,
    event_id: existing.id,
    replayed: true,
  };
}

async function getNextSequence(
  tx: Transaction,
  orderId: string,
): Promise<number> {
  const [result] = await tx
    .select({ maximum: sql<number>`coalesce(max(${schema.orderEvents.sequence}), 0)` })
    .from(schema.orderEvents)
    .where(eq(schema.orderEvents.orderId, orderId));
  return nextSequence(result?.maximum ?? 0);
}

async function performCreate(
  tx: Transaction,
  write: Extract<NormalizedWrite, { kind: "create" }>,
): Promise<WriteReceipt> {
  const [order] = await tx
    .insert(schema.orders)
    .values({
      symbol: write.input.symbol,
      side: write.input.side,
      orderType: write.input.order_type ?? null,
      limitPrice: write.input.limit_price ?? null,
      quantity: write.input.quantity,
      filledQuantity: "0",
      status: "OPEN",
    })
    .returning({ id: schema.orders.id });

  const [event] = await tx
    .insert(schema.orderEvents)
    .values({
      orderId: order.id,
      sequence: 1,
      eventType: "SUBMITTED",
      price: write.input.limit_price ?? null,
      quantity: write.input.quantity,
      occurredAt: write.input.occurred_at ?? null,
      note: write.input.note ?? null,
      idempotencyKey: write.idempotencyKey,
      requestHash: write.requestHash,
    })
    .returning({ id: schema.orderEvents.id });

  return { order_id: order.id, event_id: event.id, replayed: false };
}

async function lockWritableOrder(
  tx: Transaction,
  orderId: string,
) {
  const [order] = await tx
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .for("update");
  if (!order) throw new JournalError(404, "ORDER_NOT_FOUND", "没有找到该订单。");
  if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
    throw new JournalError(409, "ORDER_NOT_OPEN", "只有未完成订单可以成交或撤单。");
  }
  return order;
}

async function performFill(
  tx: Transaction,
  write: Extract<NormalizedWrite, { kind: "fill" }>,
): Promise<WriteReceipt> {
  const order = await lockWritableOrder(tx, write.orderId);
  if (order.quantity === null) {
    throw new JournalError(409, "ORDER_QUANTITY_UNKNOWN", "订单委托数量未知，无法验证该成交数量。");
  }

  const totalQuantity = units(order.quantity);
  const nextFilledQuantity = units(order.filledQuantity) + units(write.input.quantity);
  if (nextFilledQuantity > totalQuantity) {
    throw new JournalError(409, "FILL_EXCEEDS_ORDER", "累计成交数量不能超过委托数量。");
  }

  const status = nextFilledQuantity === totalQuantity ? "FILLED" : "PARTIALLY_FILLED";
  await tx
    .update(schema.orders)
    .set({
      filledQuantity: sql`${schema.orders.filledQuantity} + ${write.input.quantity}::numeric`,
      status,
      updatedAt: sql`statement_timestamp()`,
    })
    .where(eq(schema.orders.id, write.orderId));

  const sequence = await getNextSequence(tx, write.orderId);
  const [event] = await tx
    .insert(schema.orderEvents)
    .values({
      orderId: write.orderId,
      sequence,
      eventType: "FILLED",
      price: write.input.price,
      quantity: write.input.quantity,
      occurredAt: write.input.occurred_at ?? null,
      note: write.input.note ?? null,
      idempotencyKey: write.idempotencyKey,
      requestHash: write.requestHash,
    })
    .returning({ id: schema.orderEvents.id });

  return { order_id: write.orderId, event_id: event.id, replayed: false };
}

async function performCancel(
  tx: Transaction,
  write: Extract<NormalizedWrite, { kind: "cancel" }>,
): Promise<WriteReceipt> {
  const order = await lockWritableOrder(tx, write.orderId);
  if (order.quantity === null) {
    throw new JournalError(409, "ORDER_QUANTITY_UNKNOWN", "订单委托数量未知，无法验证撤单剩余数量。");
  }

  const remaining = units(order.quantity) - units(order.filledQuantity);
  if (remaining <= 0n) {
    throw new JournalError(409, "ORDER_NOT_OPEN", "订单没有可撤销的剩余数量。");
  }
  if (
    write.input.cancelled_quantity != null &&
    units(write.input.cancelled_quantity) !== remaining
  ) {
    throw new JournalError(
      409,
      "CANCEL_QUANTITY_MISMATCH",
      "撤单数量必须等于订单当前剩余未成交数量。",
    );
  }

  await tx
    .update(schema.orders)
    .set({ status: "CANCELLED", updatedAt: sql`statement_timestamp()` })
    .where(eq(schema.orders.id, write.orderId));

  const sequence = await getNextSequence(tx, write.orderId);
  const [event] = await tx
    .insert(schema.orderEvents)
    .values({
      orderId: write.orderId,
      sequence,
      eventType: "CANCELLED",
      quantity: write.input.cancelled_quantity ?? null,
      occurredAt: write.input.occurred_at ?? null,
      note: write.input.note ?? null,
      idempotencyKey: write.idempotencyKey,
      requestHash: write.requestHash,
    })
    .returning({ id: schema.orderEvents.id });

  return { order_id: write.orderId, event_id: event.id, replayed: false };
}

export async function writeOrder(
  db: Database,
  command: WriteCommand,
): Promise<WriteReceipt> {
  const write = normalizeWrite(command);
  return db.transaction(async (tx) => {
    await lockIdempotencyKey(tx, write.idempotencyKey);
    const replay = await findReplay(tx, write);
    if (replay) return replay;

    if (write.kind === "create") return performCreate(tx, write);
    if (write.kind === "fill") {
      return performFill(tx, write);
    }
    return performCancel(tx, write);
  });
}

function listConditions(query: ListOrdersInput) {
  const conditions = [];
  if (query.symbol) conditions.push(eq(schema.orders.symbol, query.symbol));
  if (query.status) conditions.push(eq(schema.orders.status, query.status));
  if (query.side) conditions.push(eq(schema.orders.side, query.side));

  if (query.from || query.to) {
    const eventConditions = [eq(schema.orderEvents.orderId, schema.orders.id)];
    if (query.from) eventConditions.push(gte(schema.orderEvents.occurredAt, new Date(query.from)));
    if (query.to) eventConditions.push(lt(schema.orderEvents.occurredAt, new Date(query.to)));
    // A time filter uses reported event time. Events without a supplied time
    // remain visible in unfiltered queries and are not assigned an inferred time.
    conditions.push(
      sql`exists (select 1 from ${schema.orderEvents} where ${and(...eventConditions)})`,
    );
  }

  return conditions;
}

function orderResponse(order: typeof schema.orders.$inferSelect) {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    order_type: order.orderType,
    limit_price: order.limitPrice,
    quantity: order.quantity,
    filled_quantity: order.filledQuantity,
    status: order.status,
    source_reference: order.sourceReference,
    legacy_import: order.legacyImport,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}

function eventResponse(event: typeof schema.orderEvents.$inferSelect) {
  return {
    id: event.id,
    order_id: event.orderId,
    sequence: event.sequence,
    event_type: event.eventType,
    price: event.price,
    quantity: event.quantity,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    note: event.note,
    source_reference: event.sourceReference,
    legacy_import: event.legacyImport,
  };
}

export async function listOrders(
  db: Database,
  rawQuery: Record<string, string>,
) {
  const query = parseInput(listOrdersInput.safeParse(rawQuery));
  const conditions = listConditions(query);
  const where = and(...conditions);
  const offset = (query.page - 1) * query.page_size;

  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);

    const [totalResult] = await tx
      .select({ total: count() })
      .from(schema.orders)
      .where(where);
    const rows = await tx
      .select()
      .from(schema.orders)
      .where(where)
      .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
      .limit(query.page_size)
      .offset(offset);

    return {
      items: rows.map(orderResponse),
      page: query.page,
      page_size: query.page_size,
      total: totalResult?.total ?? 0,
    };
  });
}

export async function getOrderDetailInTransaction(tx: Transaction, orderId: string) {
  const [order] = await tx
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!order) throw new JournalError(404, "ORDER_NOT_FOUND", "没有找到该订单。");

  const events = await tx
    .select()
    .from(schema.orderEvents)
    .where(eq(schema.orderEvents.orderId, orderId))
    .orderBy(schema.orderEvents.sequence);

  return {
    order: orderResponse(order),
    events: events.map(eventResponse),
  };
}

export async function getOrderDetail(db: Database, rawOrderId: string) {
  const parsedOrderId = orderIdInput.safeParse(rawOrderId);
  if (!parsedOrderId.success) {
    throw new JournalError(400, "INVALID_ORDER_ID", "必须提供有效的订单 ID。");
  }
  const orderId = parsedOrderId.data.toLowerCase();

  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);
    return getOrderDetailInTransaction(tx, orderId);
  });
}
