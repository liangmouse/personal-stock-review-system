import { createHash } from "node:crypto";
import {
  and,
  count,
  desc,
  eq,
  gte,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import * as schema from "@/db/schema";
import { JournalError, getOrderDetail } from "@/lib/orders";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const orderStatuses = [
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELLED",
  "UNKNOWN",
] as const;

const symbolInput = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,15}$/).transform((symbol) => symbol.toUpperCase());
const dateInput = z.iso.date();

const pageInput = z
  .string()
  .regex(/^[1-9]\d{0,5}$/)
  .transform(Number)
  .default(1);

const pageSizeInput = z
  .string()
  .regex(/^[1-9]\d{0,2}$/)
  .transform(Number)
  .refine((value) => value <= 100)
  .default(25);

const activityQuerySchema = z
  .object({
    symbol: symbolInput.optional(),
    side: z.enum(["BUY", "SELL"]).optional(),
    status: z.enum(orderStatuses).optional(),
    event_type: z.enum(["SUBMITTED", "FILLED", "CANCELLED"]).optional(),
    from: dateInput.optional(),
    to: dateInput.optional(),
    page: pageInput,
    page_size: pageSizeInput,
  })
  .strict()
  .superRefine((query, context) => {
    if (query.from && query.to && query.from > query.to) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "must be the same day or later than from",
      });
    }
  });

const reviewQuerySchema = z
  .object({
    filter: z.enum(["pending", "all", "reviewed"]).default("pending"),
    page: pageInput,
    page_size: pageSizeInput,
  })
  .strict();

const reviewText = z
  .string()
  .max(10_000)
  .refine(
    (value) => value.isWellFormed() && !value.includes("\0"),
    "must be valid Unicode without NUL characters",
  )
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const idempotencyKeyInput = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, "must contain printable non-space ASCII characters");

const writeReviewSchema = z
  .object({
    order_id: z.string().uuid().transform((id) => id.toLowerCase()),
    idempotency_key: idempotencyKeyInput,
    expected_version: z.number().int().min(0).max(2_147_483_646),
    pre_trade_plan: reviewText,
    followed_plan: z.boolean().nullable().optional().transform((value) => value ?? null),
    execution_review: reviewText,
    deviations: reviewText,
    lessons: reviewText,
  })
  .strict()
  .superRefine((review, context) => {
    const hasText = [
      review.pre_trade_plan,
      review.execution_review,
      review.deviations,
      review.lessons,
    ].some((value) => value?.trim().length);
    if (!hasText && review.followed_plan === null) {
      context.addIssue({
        code: "custom",
        message: "at least one review field must contain an answer",
      });
    }
  });

type WriteReviewCommand = {
  order_id: unknown;
  idempotency_key: unknown;
  expected_version: unknown;
  pre_trade_plan?: unknown;
  followed_plan?: unknown;
  execution_review?: unknown;
  deviations?: unknown;
  lessons?: unknown;
};

function parse<T>(
  result:
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: Array<{ path: PropertyKey[]; message: string }> };
      },
): T {
  if (result.success) return result.data;
  const fields = result.error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "body"} ${issue.message}`)
    .join("; ");
  throw new JournalError(400, "INVALID_INPUT", `请求字段无效：${fields}`);
}

function parseQuery<T>(
  schemaToUse: z.ZodType<T>,
  value: Record<string, string>,
): T {
  return parse(schemaToUse.safeParse(value));
}

function eventConditions(filters: z.infer<typeof activityQuerySchema>) {
  const conditions = [];
  if (filters.symbol) conditions.push(eq(schema.orders.symbol, filters.symbol));
  if (filters.side) conditions.push(eq(schema.orders.side, filters.side));
  if (filters.status) conditions.push(eq(schema.orders.status, filters.status));
  if (filters.event_type) {
    conditions.push(eq(schema.orderEvents.eventType, filters.event_type));
  }
  if (filters.from) {
    conditions.push(gte(schema.orderEvents.occurredAt, sql`(${filters.from}::date)::timestamp at time zone 'Asia/Shanghai'`));
  }
  if (filters.to) {
    conditions.push(lt(schema.orderEvents.occurredAt, sql`(${filters.to}::date + 1)::timestamp at time zone 'Asia/Shanghai'`));
  }
  return conditions;
}

function orderSummary(order: typeof schema.orders.$inferSelect) {
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

function eventSummary(
  event: typeof schema.orderEvents.$inferSelect,
  order: typeof schema.orders.$inferSelect,
) {
  return {
    id: event.id,
    order_id: order.id,
    symbol: order.symbol,
    side: order.side,
    order_status: order.status,
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

function reviewSummary(review: typeof schema.reviews.$inferSelect) {
  return {
    id: review.id,
    order_id: review.orderId,
    pre_trade_plan: review.preTradePlan,
    followed_plan: review.followedPlan,
    execution_review: review.executionReview,
    deviations: review.deviations,
    lessons: review.lessons,
    version: review.version,
    created_at: review.createdAt,
    updated_at: review.updatedAt,
  };
}

export async function getDashboard(db: Database) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);

    const [eventCount] = await tx
      .select({ value: count() })
      .from(schema.orderEvents);
    const [openOrderCount] = await tx
      .select({ value: count() })
      .from(schema.orders)
      .where(
        sql`${schema.orders.status} in ('OPEN', 'PARTIALLY_FILLED')`,
      );
    const [pendingReviewCount] = await tx
      .select({ value: count() })
      .from(schema.orders)
      .leftJoin(
        schema.reviews,
        eq(schema.reviews.orderId, schema.orders.id),
      )
      .where(isNull(schema.reviews.id));

    const recent = await tx
      .select({ event: schema.orderEvents, order: schema.orders })
      .from(schema.orderEvents)
      .innerJoin(
        schema.orders,
        eq(schema.orderEvents.orderId, schema.orders.id),
      )
      .orderBy(desc(schema.orderEvents.recordedAt), desc(schema.orderEvents.id))
      .limit(6);

    return {
      event_count: eventCount?.value ?? 0,
      open_order_count: openOrderCount?.value ?? 0,
      pending_review_count: pendingReviewCount?.value ?? 0,
      recent_events: recent.map(({ event, order }) => eventSummary(event, order)),
    };
  });
}

export async function listActivity(
  db: Database,
  rawQuery: Record<string, string>,
) {
  const filters = parseQuery(activityQuerySchema, rawQuery);
  const conditions = eventConditions(filters);
  const where = and(...conditions);
  const offset = (filters.page - 1) * filters.page_size;

  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);

    const [total] = await tx
      .select({ value: count() })
      .from(schema.orderEvents)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderEvents.orderId))
      .where(where);

    const rows = await tx
      .select({ event: schema.orderEvents, order: schema.orders })
      .from(schema.orderEvents)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderEvents.orderId))
      .where(where)
      .orderBy(
        sql`${schema.orderEvents.occurredAt} desc nulls last`,
        desc(schema.orderEvents.recordedAt),
        desc(schema.orderEvents.id),
      )
      .limit(filters.page_size)
      .offset(offset);

    return {
      items: rows.map(({ event, order }) => eventSummary(event, order)),
      page: filters.page,
      page_size: filters.page_size,
      total: total?.value ?? 0,
    };
  });
}

export async function getJournalOrderDetail(db: Database, orderId: string) {
  return getOrderDetail(db, orderId);
}

function reviewFilters(filter: "pending" | "all" | "reviewed") {
  if (filter === "pending") return isNull(schema.reviews.id);
  if (filter === "reviewed") return sql`${schema.reviews.id} is not null`;
  return undefined;
}

export async function listReviewOrders(
  db: Database,
  rawQuery: Record<string, string>,
) {
  const filters = parseQuery(reviewQuerySchema, rawQuery);
  const where = reviewFilters(filters.filter);
  const offset = (filters.page - 1) * filters.page_size;

  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);

    const [total] = await tx
      .select({ value: count() })
      .from(schema.orders)
      .leftJoin(schema.reviews, eq(schema.reviews.orderId, schema.orders.id))
      .where(where);

    const rows = await tx
      .select({ order: schema.orders, review: schema.reviews })
      .from(schema.orders)
      .leftJoin(schema.reviews, eq(schema.reviews.orderId, schema.orders.id))
      .where(where)
      .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
      .limit(filters.page_size)
      .offset(offset);

    return {
      items: rows.map(({ order, review }) => ({
        ...orderSummary(order),
        review: review ? reviewSummary(review) : null,
      })),
      page: filters.page,
      page_size: filters.page_size,
      total: total?.value ?? 0,
    };
  });
}

export async function getReview(db: Database, rawOrderId: string) {
  const parsedOrderId = z.string().uuid().safeParse(rawOrderId);
  if (!parsedOrderId.success) {
    throw new JournalError(400, "INVALID_ORDER_ID", "必须提供有效的订单 ID。");
  }
  const orderId = parsedOrderId.data.toLowerCase();

  const [order] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .limit(1);
  if (!order) throw new JournalError(404, "ORDER_NOT_FOUND", "没有找到该订单。");

  const [review] = await db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.orderId, orderId))
    .limit(1);
  return { review: review ? reviewSummary(review) : null };
}

function reviewRequestHash(review: z.infer<typeof writeReviewSchema>) {
  const payload = {
    order_id: review.order_id,
    expected_version: review.expected_version,
    pre_trade_plan: review.pre_trade_plan,
    followed_plan: review.followed_plan,
    execution_review: review.execution_review,
    deviations: review.deviations,
    lessons: review.lessons,
  };
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

async function findReviewReplay(
  tx: Transaction,
  review: z.infer<typeof writeReviewSchema>,
  requestHash: string,
) {
  const [existing] = await tx
    .select()
    .from(schema.reviewWriteReceipts)
    .where(eq(schema.reviewWriteReceipts.idempotencyKey, review.idempotency_key))
    .limit(1);
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new JournalError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "该幂等键已用于不同的复盘请求。",
    );
  }
  if (existing.orderId !== review.order_id) {
    throw new JournalError(409, "IDEMPOTENCY_KEY_REUSED", "该幂等键已用于其他订单。");
  }
  return {
    order_id: existing.orderId,
    review_id: existing.reviewId,
    version: existing.version,
    replayed: true,
  };
}

export async function writeReview(db: Database, command: WriteReviewCommand) {
  const review = parse(writeReviewSchema.safeParse(command));
  const requestHash = reviewRequestHash(review);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${review.idempotency_key}, 0))`,
    );
    const replay = await findReviewReplay(tx, review, requestHash);
    if (replay) return replay;

    const [order] = await tx
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(eq(schema.orders.id, review.order_id))
      .for("update");
    if (!order) throw new JournalError(404, "ORDER_NOT_FOUND", "没有找到该订单。");

    const [current] = await tx
      .select()
      .from(schema.reviews)
      .where(eq(schema.reviews.orderId, review.order_id))
      .limit(1);
    const currentVersion = current?.version ?? 0;
    if (review.expected_version !== currentVersion) {
      throw new JournalError(
        409,
        "REVIEW_VERSION_CONFLICT",
        "复盘已被其他请求修改，请刷新后再保存。",
      );
    }

    const values = {
      orderId: review.order_id,
      preTradePlan: review.pre_trade_plan,
      followedPlan: review.followed_plan,
      executionReview: review.execution_review,
      deviations: review.deviations,
      lessons: review.lessons,
      version: currentVersion + 1,
      updatedAt: sql`statement_timestamp()`,
    };
    const [saved] = current
      ? await tx
          .update(schema.reviews)
          .set(values)
          .where(
            and(
              eq(schema.reviews.orderId, review.order_id),
              eq(schema.reviews.version, currentVersion),
            ),
          )
          .returning({ id: schema.reviews.id, version: schema.reviews.version })
      : await tx
          .insert(schema.reviews)
          .values(values)
          .returning({ id: schema.reviews.id, version: schema.reviews.version });

    if (!saved) {
      throw new JournalError(
        409,
        "REVIEW_VERSION_CONFLICT",
        "复盘已被其他请求修改，请刷新后再保存。",
      );
    }

    await tx.insert(schema.reviewWriteReceipts).values({
      orderId: review.order_id,
      reviewId: saved.id,
      version: saved.version,
      idempotencyKey: review.idempotency_key,
      requestHash,
    });

    return {
      order_id: review.order_id,
      review_id: saved.id,
      version: saved.version,
      replayed: false,
    };
  });
}
