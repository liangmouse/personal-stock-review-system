import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

function usage() {
  process.stderr.write(
    "Usage: node scripts/backup/configure-recovery.mjs --host DIRECT_NEON_HOST --database NEW_EMPTY_DATABASE --role RECOVERY_ROLE --password-file OWNER_ONLY_FILE [--config-dir DIRECTORY]\n",
  );
  process.exit(2);
}

function parseArguments(args) {
  const values = new Map();
  while (args.length > 0) {
    const option = args.shift();
    if (!option.startsWith("--") || args.length === 0) usage();
    const name = option.slice(2);
    if (!["host", "database", "role", "password-file", "config-dir"].includes(name) || values.has(name)) usage();
    const value = args.shift();
    if (!value || value.startsWith("--")) usage();
    values.set(name, value);
  }
  for (const required of ["host", "database", "role", "password-file"]) {
    if (!values.has(required)) usage();
  }
  return values;
}

function safeCredentialFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("The database password file must be a regular owner-only file.");
  }
}

function escapeField(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function serviceField(contents, section, field) {
  let active = false;
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line)) continue;
    if (/^\s*\[/.test(line)) {
      active = line.trim() === `[${section}]`;
      continue;
    }
    const match = active ? line.match(new RegExp(`^\\s*${field}\\s*=\\s*(.*?)\\s*$`)) : null;
    if (match) return match[1].replace(/\s*[#;].*$/, "").trim();
  }
  return "";
}

const options = parseArguments(process.argv.slice(2));
const host = options.get("host");
const database = options.get("database");
const role = options.get("role");
const passwordPath = resolve(options.get("password-file"));
if (!/^ep-[a-z0-9-]+(?:\.[a-z0-9-]+)+\.neon\.tech$/.test(host) || host.includes("-pooler.")) {
  throw new Error("Use the direct Neon endpoint, without the pooler hostname.");
}
if (!/^[A-Za-z0-9_]{1,63}$/.test(database) || !/^[A-Za-z0-9_]{1,63}$/.test(role)) {
  throw new Error("Database and role names must use ASCII letters, digits, or underscores.");
}

const root = options.has("config-dir")
  ? resolve(options.get("config-dir"))
  : join(homedir(), "Library", "Application Support", "TradingJournalBackup");
const rootInfo = lstatSync(root);
if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid() || (rootInfo.mode & 0o077) !== 0) {
  throw new Error("The backup directory must be a real owner-only directory.");
}
const serviceFile = join(root, "pg_service.conf");
const passFile = join(root, "pgpass");
for (const path of [serviceFile, passFile]) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error("Existing PostgreSQL configuration must be a regular owner-only file.");
  }
}
safeCredentialFile(passwordPath);
const password = readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");
if (!password || password.includes("\n") || password.includes("\r")) {
  throw new Error("The database password file must contain one non-empty password line.");
}

const serviceContents = readFileSync(serviceFile, "utf8");
if (serviceField(serviceContents, "journal_restore", "host")) {
  throw new Error("A journal_restore service already exists. Review it before changing it.");
}
const sourceHost = serviceField(serviceContents, "journal_backup", "host");
const sourceDatabase = serviceField(serviceContents, "journal_backup", "dbname");
if (!sourceHost || !sourceDatabase || (sourceHost === host && sourceDatabase === database)) {
  throw new Error("The restore destination must differ from the configured source database.");
}

const service = [
  "[journal_restore]",
  `host=${host}`,
  "port=5432",
  `dbname=${database}`,
  `user=${role}`,
  "sslmode=verify-full",
  "sslrootcert=/etc/ssl/cert.pem",
  "application_name=personal-trading-journal-restore",
  "",
].join("\n");
const passEntry = `${host}:5432:${database}:${role}:${escapeField(password)}\n`;
const suffix = randomBytes(6).toString("hex");
const serviceTemp = join(root, `.pg_service.${suffix}.tmp`);
const passTemp = join(root, `.pgpass.${suffix}.tmp`);
try {
  writeFileSync(serviceTemp, `${serviceContents.trimEnd()}\n\n${service}`, { mode: 0o600, flag: "wx" });
  writeFileSync(passTemp, `${readFileSync(passFile, "utf8").trimEnd()}\n${passEntry}`, { mode: 0o600, flag: "wx" });
  chmodSync(serviceTemp, 0o600);
  chmodSync(passTemp, 0o600);
  renameSync(passTemp, passFile);
  renameSync(serviceTemp, serviceFile);
} catch (error) {
  for (const temporary of [serviceTemp, passTemp]) {
    try { unlinkSync(temporary); } catch {}
  }
  throw error;
}

process.stdout.write("The recovery database service was added to the private local libpq configuration.\n");
process.stdout.write("The restore command still verifies that the database is separate and empty before use.\n");
