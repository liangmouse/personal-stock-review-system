CREATE TABLE "review_write_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"idempotency_key" varchar(200) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_write_receipts_version_positive_ck" CHECK ("review_write_receipts"."version" > 0),
	CONSTRAINT "review_write_receipts_request_hash_ck" CHECK ("review_write_receipts"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_write_receipts" ADD CONSTRAINT "review_write_receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_write_receipts" ADD CONSTRAINT "review_write_receipts_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "review_write_receipts_idempotency_key_uq" ON "review_write_receipts" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "review_write_receipts_order_version_uq" ON "review_write_receipts" USING btree ("order_id","version");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_version_positive_ck" CHECK ("reviews"."version" > 0);--> statement-breakpoint
CREATE FUNCTION reject_review_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review_write_receipts is append-only' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_write_receipts_append_only
BEFORE UPDATE OR DELETE OR TRUNCATE ON review_write_receipts
FOR EACH STATEMENT EXECUTE FUNCTION reject_review_receipt_mutation();
