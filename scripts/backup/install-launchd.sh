#!/bin/bash

set -euo pipefail
umask 077

ROOT="${HOME:?}/Library/Application Support/TradingJournalBackup"
install=0
while (($#)); do
  case "$1" in
    --config-dir)
      [[ $# -ge 2 && -n "$2" ]] || { printf 'Usage: %s [--config-dir DIRECTORY] [--install]\n' "$0" >&2; exit 2; }
      ROOT=$2
      shift 2
      ;;
    --install)
      install=1
      shift
      ;;
    *)
      printf 'Usage: %s [--config-dir DIRECTORY] [--install]\n' "$0" >&2
      exit 2
      ;;
  esac
done
REPOSITORY=$(cd "$(dirname "$0")/../.." && pwd -P)
LABEL=com.personal-trading-journal.backup
AGENTS="$HOME/Library/LaunchAgents"
PLIST="$AGENTS/$LABEL.plist"
LOGS="$ROOT/logs"

[[ -d "$ROOT" && ! -L "$ROOT" && "$(stat -f '%u:%Lp' "$ROOT")" == "$(id -u):700" && \
  -f "$ROOT/config" && ! -L "$ROOT/config" && "$(stat -f '%u:%Lp' "$ROOT/config")" == "$(id -u):600" ]] || {
  printf 'journal-backup-launchd: configure the backup before installing its schedule\n' >&2
  exit 1
}

temporary_directory=
if (( install )); then
  [[ ! -e "$PLIST" && ! -L "$PLIST" ]] || {
    printf 'journal-backup-launchd: an existing schedule file must be reviewed first\n' >&2
    exit 1
  }
  mkdir -p "$AGENTS" "$LOGS"
  chmod 700 "$ROOT" "$LOGS"
  temporary="$AGENTS/.$LABEL.$$.plist"
else
  temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/journal-backup-launchd.XXXXXX")
  temporary="$temporary_directory/$LABEL.plist"
fi
cleanup() {
  [[ ! -e "$temporary" ]] || /bin/rm -f "$temporary"
  [[ -z "$temporary_directory" ]] || /bin/rmdir "$temporary_directory" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cat > "$temporary" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPOSITORY/scripts/backup/backup.sh</string>
    <string>--config-dir</string>
    <string>$ROOT</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPOSITORY</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>15</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>$LOGS/backup.log</string>
  <key>StandardErrorPath</key>
  <string>$LOGS/backup-error.log</string>
</dict>
</plist>
PLIST

chmod 600 "$temporary"
plutil -lint "$temporary" >/dev/null
launchctl print "gui/$(id -u)" >/dev/null 2>&1 || {
  printf 'journal-backup-launchd: the current user launchd domain is unavailable\n' >&2
  exit 1
}
if (( install )); then
  /bin/mv "$temporary" "$PLIST"
  temporary=
  chmod 600 "$PLIST"
  printf 'launchd schedule file installed but not loaded: %s\n' "$PLIST"
  printf 'After review, enable it with: launchctl bootstrap gui/%s %s\n' "$(id -u)" "$PLIST"
  exit 0
fi

printf 'launchd validated the daily job. It was not installed or loaded.\n'
