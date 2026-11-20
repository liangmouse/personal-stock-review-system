#!/bin/bash

set -euo pipefail
umask 077

ROOT="${HOME:?}/Library/Application Support/TradingJournalBackup"
backup_file=
while (($#)); do
  case "$1" in
    --config-dir)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'Usage: %s --restore FILE [--config-dir DIRECTORY]\n' "$0" >&2; exit 2; }
      ROOT=$2
      shift 2
      ;;
    --restore)
      [[ $# -ge 2 && -z "$backup_file" ]] || { printf 'Usage: %s --restore FILE [--config-dir DIRECTORY]\n' "$0" >&2; exit 2; }
      backup_file=$2
      shift 2
      ;;
    *)
      printf 'Usage: %s --restore FILE [--config-dir DIRECTORY]\n' "$0" >&2
      exit 2
      ;;
  esac
done
CONFIG_FILE="$ROOT/config"
PGSERVICEFILE="$ROOT/pg_service.conf"
PGPASSFILE="$ROOT/pgpass"
PRIVATE_KEY="$ROOT/recovery/private-key.pem"
PASSPHRASE_FILE="$ROOT/recovery/restore-passphrase"
BACKUP_DIRECTORY="$ROOT/snapshots"
CERTIFICATE="$ROOT/recipient.crt"
CERTIFICATE_HASH_FILE="$ROOT/recipient.crt.sha256"

fail() {
  printf 'journal-backup-restore: %s\n' "$1" >&2
  exit 1
}

if [[ -z "$backup_file" ]]; then
  printf 'Usage: %s --restore /path/to/journal-YYYYMMDDTHHMMSSZ.cms [--config-dir DIRECTORY]\n' "$0" >&2
  exit 2
fi

[[ -f "$backup_file" && ! -L "$backup_file" ]] || fail 'the encrypted backup file is unavailable'
[[ "$(stat -f '%u:%Lp' "$backup_file")" == "$(id -u):600" ]] ||
  fail 'the encrypted backup file has unsafe ownership or permissions'
backup_directory=$(cd "$(dirname "$backup_file")" && pwd -P)
[[ "$backup_directory" == "$(cd "$BACKUP_DIRECTORY" 2>/dev/null && pwd -P)" ]] ||
  fail 'restore accepts backups from the configured snapshot directory only'
[[ -d "$BACKUP_DIRECTORY" && ! -L "$BACKUP_DIRECTORY" && \
  "$(stat -f '%u:%Lp' "$BACKUP_DIRECTORY")" == "$(id -u):700" ]] ||
  fail 'snapshot directory has unsafe ownership or permissions'
[[ "$(basename "$backup_file")" =~ ^journal-[0-9]{8}T[0-9]{6}Z\.cms$ ]] ||
  fail 'the selected file name is not a journal snapshot'

for file in "$CONFIG_FILE" "$PGSERVICEFILE" "$PGPASSFILE" "$PRIVATE_KEY" "$PASSPHRASE_FILE" "$CERTIFICATE" "$CERTIFICATE_HASH_FILE"; do
  [[ -f "$file" && ! -L "$file" ]] || fail 'restore configuration is incomplete'
  [[ "$(stat -f '%u:%Lp' "$file")" == "$(id -u):600" ]] || fail 'a private recovery file has unsafe permissions'
done
[[ -d "$ROOT" && ! -L "$ROOT" && "$(stat -f '%u:%Lp' "$ROOT")" == "$(id -u):700" ]] ||
  fail 'recovery directory has unsafe ownership or permissions'
expected_certificate_hash=$(cat "$CERTIFICATE_HASH_FILE") || fail 'recovery certificate metadata is unavailable'
actual_certificate_hash=$(shasum -a 256 "$CERTIFICATE" 2>/dev/null | awk '{print $1}') ||
  fail 'recovery certificate could not be verified'
[[ "$expected_certificate_hash" =~ ^[[:xdigit:]]{64}$ && "$expected_certificate_hash" == "$actual_certificate_hash" ]] ||
  fail 'recovery certificate does not match its configured fingerprint'

PG_BIN_DIR=
OPENSSL_BIN=
while IFS='=' read -r name value; do
  case "$name" in
    PG_BIN_DIR) PG_BIN_DIR=$value ;;
    OPENSSL_BIN) OPENSSL_BIN=$value ;;
  esac
done < "$CONFIG_FILE"
[[ -n "$PG_BIN_DIR" && -n "$OPENSSL_BIN" ]] || fail 'restore client paths are missing'
PG_RESTORE="$PG_BIN_DIR/pg_restore"
PSQL="$PG_BIN_DIR/psql"
OPENSSL="$OPENSSL_BIN"
[[ -x "$PG_RESTORE" ]] || PG_RESTORE="$(command -v pg_restore || true)"
[[ -x "$PSQL" ]] || PSQL="$(command -v psql || true)"
[[ -x "$PG_RESTORE" && -x "$PSQL" && -x "$OPENSSL" ]] || fail 'a required restore program is unavailable'

export PGSERVICEFILE PGPASSFILE
export PGSSLROOTCERT=/etc/ssl/cert.pem
export PATH="$PG_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
unset PGPASSWORD DATABASE_URL JOURNAL_API_TOKEN JOURNAL_MCP_TOKEN JOURNAL_WEB_PASSWORD
[[ -r "$PGSSLROOTCERT" ]] || fail 'the macOS system certificate bundle is unavailable'

service_value() {
  local section=$1 field=$2
  awk -v section="[$section]" -v field="$field" '
    /^[[:space:]]*[#;]/ { next }
    /^[[:space:]]*\[/ { active = ($0 == section); next }
    active && $0 ~ "^[[:space:]]*" field "[[:space:]]*=" {
      sub("^[[:space:]]*" field "[[:space:]]*=[[:space:]]*", "")
      sub(/[[:space:]]*[#;].*$/, "")
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      print
      exit
    }
  ' "$PGSERVICEFILE"
}

source_host=$(service_value journal_backup host)
source_database=$(service_value journal_backup dbname)
target_host=$(service_value journal_restore host)
target_database=$(service_value journal_restore dbname)
[[ -n "$source_host" && -n "$source_database" && -n "$target_host" && -n "$target_database" ]] ||
  fail 'source and recovery database services must both be configured'
[[ "$source_host" != "$target_host" || "$source_database" != "$target_database" ]] ||
  fail 'the recovery database points to the configured source database'
[[ "$target_host" != *-pooler.* ]] || fail 'the recovery database must use a direct PostgreSQL endpoint'

empty_result=$("$PSQL" --no-psqlrc --no-align --tuples-only --set=ON_ERROR_STOP=1 \
  --dbname='service=journal_restore' \
  --command="select current_setting('transaction_read_only') || ':' || (
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public','drizzle')
        and not exists (select 1 from pg_depend d
          where d.classid = 'pg_class'::regclass and d.objid = c.oid
            and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')) +
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','drizzle')
        and not exists (select 1 from pg_depend d
          where d.classid = 'pg_proc'::regclass and d.objid = p.oid
            and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')) +
    (select count(*) from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname in ('public','drizzle') and t.typtype <> 'p'
        and not exists (select 1 from pg_depend d
          where d.classid = 'pg_type'::regclass and d.objid = t.oid
            and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e')) +
    (select count(*) from pg_largeobject_metadata) +
    (select count(*) from pg_namespace where nspname = 'drizzle')
  )::text" 2>/dev/null) || fail 'the recovery database could not be checked'
[[ "$empty_result" == 'off:0' ]] || fail 'recovery stopped because the target database is not new and empty'

# Validate the GCM authentication tag before allowing pg_restore to connect.
if ! "$OPENSSL" cms -decrypt -binary -inform DER -in "$backup_file" \
  -recip "$ROOT/recipient.crt" -inkey "$PRIVATE_KEY" \
  -passin "file:$PASSPHRASE_FILE" -out /dev/null 2>/dev/null; then
  fail 'backup authentication failed; the recovery database was not changed'
fi

# pg_restore's TOC contains only archive metadata, not table contents. Remove
# the CREATE SCHEMA entry for public because every new PostgreSQL database has
# that schema already (and Neon may populate it with extension-owned objects).
metadata_directory=$(mktemp -d "$ROOT/.restore-metadata.XXXXXX") ||
  fail 'temporary recovery metadata could not be created'
toc_file="$metadata_directory/archive.list"
filtered_toc_file="$metadata_directory/restore.list"
cleanup_metadata() {
  [[ -z "${metadata_directory:-}" || ! -d "$metadata_directory" ]] || /bin/rm -rf "$metadata_directory"
}
trap cleanup_metadata EXIT
trap 'exit 1' HUP INT TERM

if ! "$OPENSSL" cms -decrypt -binary -inform DER -in "$backup_file" \
  -recip "$ROOT/recipient.crt" -inkey "$PRIVATE_KEY" \
  -passin "file:$PASSPHRASE_FILE" 2>/dev/null |
  "$PG_RESTORE" --list >"$toc_file" 2>/dev/null; then
  fail 'backup archive metadata could not be read'
fi
chmod 600 "$toc_file"
if ! awk '!/^[0-9]+; [0-9]+ [0-9]+ SCHEMA - public( |$)/' "$toc_file" >"$filtered_toc_file"; then
  fail 'backup archive metadata could not be prepared'
fi
chmod 600 "$filtered_toc_file"

stage='authenticated decryption or transactional restore'
if ! "$OPENSSL" cms -decrypt -binary -inform DER -in "$backup_file" \
  -recip "$ROOT/recipient.crt" -inkey "$PRIVATE_KEY" \
  -passin "file:$PASSPHRASE_FILE" 2>/dev/null |
  "$PG_RESTORE" --format=custom --use-list="$filtered_toc_file" \
    --dbname='service=journal_restore' \
    --single-transaction --exit-on-error --no-owner --no-acl 2>/dev/null; then
  fail "$stage failed; the database transaction was rolled back"
fi

printf 'journal-backup-restore: recovery completed to the configured empty database\n'
