-- Run as the migration owner after applying the schema.
-- The two LOGIN roles are provisioned separately with independent credentials.
BEGIN;
GRANT USAGE ON SCHEMA public TO journal_runtime;
GRANT SELECT, INSERT, UPDATE ON orders, reviews, write_rate_limit TO journal_runtime;
GRANT SELECT, INSERT ON order_events, review_write_receipts TO journal_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_authorization_codes, oauth_access_tokens, oauth_refresh_tokens TO journal_runtime;

GRANT USAGE ON SCHEMA public, drizzle TO journal_backup_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public, drizzle TO journal_backup_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public, drizzle TO journal_backup_reader;
COMMIT;
