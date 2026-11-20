CREATE TABLE "oauth_access_tokens" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"family_id" uuid,
	"client_id" varchar(64) NOT NULL,
	"scope" varchar(64) NOT NULL,
	"resource" text NOT NULL,
	"authorization_version" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_access_tokens_hash_ck" CHECK ("oauth_access_tokens"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "oauth_access_tokens_scope_ck" CHECK ("oauth_access_tokens"."scope" in ('journal', 'journal offline_access'))
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"code_hash" varchar(64) PRIMARY KEY NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" varchar(64) NOT NULL,
	"resource" text NOT NULL,
	"code_challenge" varchar(43) NOT NULL,
	"code_challenge_method" varchar(8) NOT NULL,
	"authorization_version" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_codes_hash_ck" CHECK ("oauth_authorization_codes"."code_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "oauth_authorization_codes_challenge_ck" CHECK ("oauth_authorization_codes"."code_challenge" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "oauth_authorization_codes_method_ck" CHECK ("oauth_authorization_codes"."code_challenge_method" = 'S256'),
	CONSTRAINT "oauth_authorization_codes_scope_ck" CHECK ("oauth_authorization_codes"."scope" in ('journal', 'journal offline_access'))
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"token_hash" varchar(64) PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"client_id" varchar(64) NOT NULL,
	"scope" varchar(64) NOT NULL,
	"resource" text NOT NULL,
	"authorization_version" varchar(64) NOT NULL,
	"family_expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_hash_ck" CHECK ("oauth_refresh_tokens"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "oauth_refresh_tokens_scope_ck" CHECK ("oauth_refresh_tokens"."scope" = 'journal offline_access')
);
--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_family_idx" ON "oauth_access_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_expires_idx" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_expires_idx" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_family_idx" ON "oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_expiry_idx" ON "oauth_refresh_tokens" USING btree ("family_expires_at");