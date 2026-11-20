#!/bin/bash

set -euo pipefail
umask 077

ROOT="${HOME:?}/Library/Application Support/TradingJournalBackup"
while (($#)); do
  case "$1" in
    --config-dir)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'Usage: %s [--config-dir DIRECTORY]\n' "$0" >&2; exit 2; }
      ROOT=$2
      shift 2
      ;;
    *)
      printf 'Usage: %s [--config-dir DIRECTORY]\n' "$0" >&2
      exit 2
      ;;
  esac
done
CONFIG_FILE="$ROOT/config"
PGSERVICEFILE="$ROOT/pg_service.conf"
PGPASSFILE="$ROOT/pgpass"
BACKUP_DIRECTORY="$ROOT/snapshots"
CERTIFICATE="$ROOT/recipient.crt"
CERTIFICATE_HASH_FILE="$ROOT/recipient.crt.sha256"

fail() {
  printf 'journal-backup: %s\n' "$1" >&2
  exit 1
}

check_private_file() {
  local file=$1
  [[ -f "$file" && ! -L "$file" ]] || fail 'backup configuration is incomplete'
  [[ "$(stat -f '%u:%Lp' "$file")" == "$(id -u):600" ]] || fail 'a private configuration file has unsafe permissions'
}

[[ -d "$ROOT" && ! -L "$ROOT" && "$(stat -f '%u:%Lp' "$ROOT")" == "$(id -u):700" ]] ||
  fail 'backup directory has unsafe ownership or permissions'
check_private_file "$CONFIG_FILE"
check_private_file "$PGSERVICEFILE"
check_private_file "$PGPASSFILE"
check_private_file "$CERTIFICATE"
check_private_file "$CERTIFICATE_HASH_FILE"
expected_certificate_hash=$(cat "$CERTIFICATE_HASH_FILE") || fail 'backup certificate metadata is unavailable'
actual_certificate_hash=$(shasum -a 256 "$CERTIFICATE" 2>/dev/null | awk '{print $1}') ||
  fail 'backup certificate could not be verified'
[[ "$expected_certificate_hash" =~ ^[[:xdigit:]]{64}$ && "$expected_certificate_hash" == "$actual_certificate_hash" ]] ||
  fail 'backup certificate does not match its configured fingerprint'

PG_BIN_DIR=
OPENSSL_BIN=
while IFS='=' read -r name value; do
  case "$name" in
    PG_BIN_DIR) PG_BIN_DIR=$value ;;
    OPENSSL_BIN) OPENSSL_BIN=$value ;;
  esac
done < "$CONFIG_FILE"
[[ -n "$PG_BIN_DIR" && -n "$OPENSSL_BIN" ]] || fail 'backup client paths are missing'

PG_DUMP="$PG_BIN_DIR/pg_dump"
PSQL="$PG_BIN_DIR/psql"
OPENSSL="$OPENSSL_BIN"
[[ -x "$PG_DUMP" ]] || PG_DUMP="$(command -v pg_dump || true)"
[[ -x "$PSQL" ]] || PSQL="$(command -v psql || true)"
[[ -x "$PG_DUMP" && -x "$PSQL" && -x "$OPENSSL" ]] || fail 'a required backup program is unavailable'

pg_dump_version=$($PG_DUMP --version 2>/dev/null | awk '{print $3}')
pg_dump_major=${pg_dump_version%%.*}
[[ "$pg_dump_major" =~ ^[0-9]+$ && "$pg_dump_major" -ge 17 ]] ||
  fail 'pg_dump 17 or newer is required'

export PGSERVICEFILE PGPASSFILE
export PGSSLROOTCERT=/etc/ssl/cert.pem
export PATH="$PG_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin"
unset PGPASSWORD DATABASE_URL JOURNAL_API_TOKEN JOURNAL_MCP_TOKEN JOURNAL_WEB_PASSWORD
[[ -r "$PGSSLROOTCERT" ]] || fail 'the macOS system certificate bundle is unavailable'

migration_table_exists=$("$PSQL" --no-psqlrc --no-align --tuples-only --set=ON_ERROR_STOP=1 \
  --dbname='service=journal_backup' \
  --command="SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL" 2>/dev/null) ||
  fail 'the migration table could not be checked'
[[ "$migration_table_exists" == 't' ]] || fail 'the Drizzle migration table is unavailable'

if [[ ! -e "$BACKUP_DIRECTORY" ]]; then
  mkdir -m 700 "$BACKUP_DIRECTORY"
fi
[[ -d "$BACKUP_DIRECTORY" && ! -L "$BACKUP_DIRECTORY" && \
  "$(stat -f '%u:%Lp' "$BACKUP_DIRECTORY")" == "$(id -u):700" ]] ||
  fail 'snapshot directory has unsafe ownership or permissions'

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
destination="$BACKUP_DIRECTORY/journal-$timestamp.cms"
partial="$BACKUP_DIRECTORY/.journal-$timestamp.$$.partial"
cleanup() {
  [[ -z "${partial:-}" || ! -e "$partial" ]] || /bin/rm -f "$partial"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

stage='database export or encryption'
if ! "$PG_DUMP" --format=custom --no-owner --no-acl \
  --schema=public --schema=drizzle --strict-names --exclude-extension='*' \
  --dbname='service=journal_backup' --file=/dev/stdout 2>/dev/null |
  "$OPENSSL" cms -encrypt -binary -aes-256-gcm -stream \
    -in - -out "$partial" -outform DER "$CERTIFICATE" 2>/dev/null; then
  fail "$stage failed"
fi

[[ -s "$partial" ]] || fail 'encrypted backup is empty'
if ! "$OPENSSL" cms -cmsout -print -noout -inform DER -in "$partial" 2>/dev/null |
  awk '
    /contentType: id-smime-ct-authEnvelopedData/ { authenticated = 1 }
    /algorithm: aes-256-gcm/ { gcm = 1 }
    END { if (!authenticated || !gcm) exit 1 }
  '; then
  fail 'encrypted backup is missing authenticated AES-256-GCM encryption'
fi

chmod 600 "$partial"
[[ ! -e "$destination" ]] || fail 'a backup with this timestamp already exists'
ln "$partial" "$destination" 2>/dev/null || fail 'a backup with this timestamp already exists'
/bin/rm -f "$partial"
partial=

# Prune only after a complete encrypted backup has been atomically installed.
find "$BACKUP_DIRECTORY" -type f -name 'journal-*.cms' -mtime +29 -delete

printf 'journal-backup: encrypted snapshot saved (%s)\n' "$(basename "$destination")"
