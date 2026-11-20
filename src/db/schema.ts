import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const orderSide = pgEnum("order_side", ["BUY", "SELL"]);
export const orderType = pgEnum("order_type", ["LIMIT", "MARKET"]);
export const orderStatus = pgEnum("order_status", [
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELLED",
  "UNKNOWN",
]);
export const orderEventType = pgEnum("order_event_type", [
  "SUBMITTED",
  "FILLED",
  "CANCELLED",
]);

const preciseDecimal = { precision: 20, scale: 8 } as const;

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    symbol: varchar("symbol", { length: 16 }).notNull(),
    side: orderSide("side").notNull(),
    orderType: orderType("order_type"),
    limitPrice: numeric("limit_price", preciseDecimal),
    quantity: numeric("quantity", preciseDecimal),
    filledQuantity: numeric("filled_quantity", preciseDecimal)
      .notNull()
      .default("0"),
    status: orderStatus("status").notNull().default("OPEN"),
    sourceReference: varchar("source_reference", { length: 64 }),
    legacyImport: boolean("legacy_import").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "orders_symbol_format_ck",
      sql`${table.symbol} ~ '^[A-Z0-9][A-Z0-9.-]{0,15}$'`,
    ),
    check(
      "orders_limit_price_positive_ck",
      sql`${table.limitPrice} is null or (${table.limitPrice} <> 'NaN'::numeric and ${table.limitPrice} > 0)`,
    ),
    check(
      "orders_quantity_positive_ck",
      sql`${table.quantity} is null or (${table.quantity} <> 'NaN'::numeric and ${table.quantity} > 0)`,
    ),
    check(
      "orders_filled_quantity_valid_ck",
      sql`${table.filledQuantity} <> 'NaN'::numeric and ${table.filledQuantity} >= 0 and (${table.quantity} is null or ${table.filledQuantity} <= ${table.quantity})`,
    ),
    check(
      "orders_known_state_consistent_ck",
      sql`(${table.status} = 'UNKNOWN' and ${table.legacyImport}) or (${table.status} = 'OPEN' and ${table.quantity} is not null and ${table.filledQuantity} = 0) or (${table.status} = 'PARTIALLY_FILLED' and ${table.quantity} is not null and ${table.filledQuantity} > 0 and ${table.filledQuantity} < ${table.quantity}) or (${table.status} = 'FILLED' and ${table.quantity} is not null and ${table.filledQuantity} = ${table.quantity}) or (${table.status} = 'CANCELLED' and ${table.quantity} is not null and ${table.filledQuantity} < ${table.quantity})`,
    ),
    check(
      "orders_nonlegacy_complete_ck",
      sql`${table.legacyImport} or (${table.quantity} is not null and ${table.status} <> 'UNKNOWN')`,
    ),
    check(
      "orders_limit_price_consistent_ck",
      sql`case when ${table.orderType} = 'LIMIT' then ${table.limitPrice} is not null else ${table.limitPrice} is null end`,
    ),
    index("orders_symbol_idx").on(table.symbol),
    index("orders_status_idx").on(table.status),
    index("orders_created_at_idx").on(table.createdAt),
  ],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    eventType: orderEventType("event_type").notNull(),
    price: numeric("price", preciseDecimal),
    quantity: numeric("quantity", preciseDecimal),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    note: text("note"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    sourceReference: varchar("source_reference", { length: 64 }),
    legacyImport: boolean("legacy_import").notNull().default(false),
  },
  (table) => [
    check("order_events_sequence_positive_ck", sql`${table.sequence} > 0`),
    check(
      "order_events_price_positive_ck",
      sql`${table.price} is null or (${table.price} <> 'NaN'::numeric and ${table.price} > 0)`,
    ),
    check(
      "order_events_quantity_positive_ck",
      sql`${table.quantity} is null or (${table.quantity} <> 'NaN'::numeric and ${table.quantity} > 0)`,
    ),
    check(
      "order_events_legacy_source_ck",
      sql`not ${table.legacyImport} or ${table.sourceReference} is not null`,
    ),
    check(
      "order_events_idempotency_hash_ck",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "order_events_required_values_ck",
      sql`(${table.eventType} <> 'SUBMITTED' or ${table.quantity} is not null) and (${table.eventType} <> 'FILLED' or (${table.quantity} is not null and (${table.price} is not null or (${table.legacyImport} and ${table.sourceReference} is not null))))`,
    ),
    uniqueIndex("order_events_order_sequence_uq").on(
      table.orderId,
      table.sequence,
    ),
    uniqueIndex("order_events_idempotency_key_uq").on(table.idempotencyKey),
    index("order_events_order_recorded_idx").on(
      table.orderId,
      table.recordedAt,
    ),
    index("order_events_occurred_at_idx").on(table.occurredAt),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    preTradePlan: text("pre_trade_plan"),
    followedPlan: boolean("followed_plan"),
    executionReview: text("execution_review"),
    deviations: text("deviations"),
    lessons: text("lessons"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("reviews_version_positive_ck", sql`${table.version} > 0`),
    uniqueIndex("reviews_order_id_uq").on(table.orderId),
  ],
);

export const reviewWriteReceipts = pgTable(
  "review_write_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("review_write_receipts_version_positive_ck", sql`${table.version} > 0`),
    check(
      "review_write_receipts_request_hash_ck",
      sql`${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    uniqueIndex("review_write_receipts_idempotency_key_uq").on(table.idempotencyKey),
    uniqueIndex("review_write_receipts_order_version_uq").on(table.orderId, table.version),
  ],
);

export const writeRateLimit = pgTable("write_rate_limit", {
  id: integer("id").primaryKey(),
  windowStart: timestamp("window_start", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  hits: integer("hits").notNull(),
});

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    codeHash: varchar("code_hash", { length: 64 }).primaryKey(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scope: varchar("scope", { length: 64 }).notNull(),
    resource: text("resource").notNull(),
    codeChallenge: varchar("code_challenge", { length: 43 }).notNull(),
    codeChallengeMethod: varchar("code_challenge_method", { length: 8 }).notNull(),
    authorizationVersion: varchar("authorization_version", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("oauth_authorization_codes_hash_ck", sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`),
    check("oauth_authorization_codes_challenge_ck", sql`${table.codeChallenge} ~ '^[A-Za-z0-9_-]{43}$'`),
    check("oauth_authorization_codes_method_ck", sql`${table.codeChallengeMethod} = 'S256'`),
    check("oauth_authorization_codes_scope_ck", sql`${table.scope} in ('journal', 'journal offline_access')`),
    index("oauth_authorization_codes_expires_idx").on(table.expiresAt),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
    familyId: uuid("family_id"),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    scope: varchar("scope", { length: 64 }).notNull(),
    resource: text("resource").notNull(),
    authorizationVersion: varchar("authorization_version", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("oauth_access_tokens_hash_ck", sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
    check("oauth_access_tokens_scope_ck", sql`${table.scope} in ('journal', 'journal offline_access')`),
    index("oauth_access_tokens_family_idx").on(table.familyId),
    index("oauth_access_tokens_expires_idx").on(table.expiresAt),
  ],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
    familyId: uuid("family_id").notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    scope: varchar("scope", { length: 64 }).notNull(),
    resource: text("resource").notNull(),
    authorizationVersion: varchar("authorization_version", { length: 64 }).notNull(),
    familyExpiresAt: timestamp("family_expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("oauth_refresh_tokens_hash_ck", sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
    check("oauth_refresh_tokens_scope_ck", sql`${table.scope} = 'journal offline_access'`),
    index("oauth_refresh_tokens_family_idx").on(table.familyId),
    index("oauth_refresh_tokens_expiry_idx").on(table.familyExpiresAt),
  ],
);

export const schema = {
  orders,
  orderEvents,
  reviews,
  reviewWriteReceipts,
  writeRateLimit,
  oauthAuthorizationCodes,
  oauthAccessTokens,
  oauthRefreshTokens,
};
