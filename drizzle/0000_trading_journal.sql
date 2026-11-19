CREATE TYPE "public"."order_event_type" AS ENUM('SUBMITTED', 'FILLED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('BUY', 'SELL');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('LIMIT', 'MARKET');--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" "order_event_type" NOT NULL,
	"price" numeric(20, 8),
	"quantity" numeric(20, 8),
	"occurred_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"source_reference" varchar(64),
	"legacy_import" boolean DEFAULT false NOT NULL,
	CONSTRAINT "order_events_sequence_positive_ck" CHECK ("order_events"."sequence" > 0),
	CONSTRAINT "order_events_price_positive_ck" CHECK ("order_events"."price" is null or ("order_events"."price" <> 'NaN'::numeric and "order_events"."price" > 0)),
	CONSTRAINT "order_events_quantity_positive_ck" CHECK ("order_events"."quantity" is null or ("order_events"."quantity" <> 'NaN'::numeric and "order_events"."quantity" > 0)),
	CONSTRAINT "order_events_legacy_source_ck" CHECK (not "order_events"."legacy_import" or "order_events"."source_reference" is not null),
	CONSTRAINT "order_events_idempotency_hash_ck" CHECK ("order_events"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "order_events_required_values_ck" CHECK (("order_events"."event_type" <> 'SUBMITTED' or "order_events"."quantity" is not null) and ("order_events"."event_type" <> 'FILLED' or ("order_events"."quantity" is not null and ("order_events"."price" is not null or ("order_events"."legacy_import" and "order_events"."source_reference" is not null)))))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"symbol" varchar(16) NOT NULL,
	"side" "order_side" NOT NULL,
	"order_type" "order_type",
	"limit_price" numeric(20, 8),
	"quantity" numeric(20, 8),
	"filled_quantity" numeric(20, 8) DEFAULT '0' NOT NULL,
	"status" "order_status" DEFAULT 'OPEN' NOT NULL,
	"source_reference" varchar(64),
	"legacy_import" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_symbol_format_ck" CHECK ("orders"."symbol" ~ '^[A-Z0-9][A-Z0-9.-]{0,15}$'),
	CONSTRAINT "orders_limit_price_positive_ck" CHECK ("orders"."limit_price" is null or ("orders"."limit_price" <> 'NaN'::numeric and "orders"."limit_price" > 0)),
	CONSTRAINT "orders_quantity_positive_ck" CHECK ("orders"."quantity" is null or ("orders"."quantity" <> 'NaN'::numeric and "orders"."quantity" > 0)),
	CONSTRAINT "orders_filled_quantity_valid_ck" CHECK ("orders"."filled_quantity" <> 'NaN'::numeric and "orders"."filled_quantity" >= 0 and ("orders"."quantity" is null or "orders"."filled_quantity" <= "orders"."quantity")),
	CONSTRAINT "orders_known_state_consistent_ck" CHECK (("orders"."status" = 'UNKNOWN' and "orders"."legacy_import") or ("orders"."status" = 'OPEN' and "orders"."quantity" is not null and "orders"."filled_quantity" = 0) or ("orders"."status" = 'PARTIALLY_FILLED' and "orders"."quantity" is not null and "orders"."filled_quantity" > 0 and "orders"."filled_quantity" < "orders"."quantity") or ("orders"."status" = 'FILLED' and "orders"."quantity" is not null and "orders"."filled_quantity" = "orders"."quantity") or ("orders"."status" = 'CANCELLED' and "orders"."quantity" is not null and "orders"."filled_quantity" < "orders"."quantity")),
	CONSTRAINT "orders_nonlegacy_complete_ck" CHECK ("orders"."legacy_import" or ("orders"."quantity" is not null and "orders"."status" <> 'UNKNOWN')),
	CONSTRAINT "orders_limit_price_consistent_ck" CHECK (case when "orders"."order_type" = 'LIMIT' then "orders"."limit_price" is not null else "orders"."limit_price" is null end)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"pre_trade_plan" text,
	"followed_plan" boolean,
	"execution_review" text,
	"deviations" text,
	"lessons" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "write_rate_limit" (
	"id" integer PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_order_sequence_uq" ON "order_events" USING btree ("order_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "order_events_idempotency_key_uq" ON "order_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "order_events_order_recorded_idx" ON "order_events" USING btree ("order_id","recorded_at");--> statement-breakpoint
CREATE INDEX "order_events_occurred_at_idx" ON "order_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "orders_symbol_idx" ON "orders" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reviews_order_id_uq" ON "reviews" USING btree ("order_id");