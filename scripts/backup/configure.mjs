import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function usage() {
  process.stderr.write(
    "Usage: node scripts/backup/configure.mjs --host DIRECT_NEON_HOST --database NAME --role READ_ONLY_ROLE --password-file OWNER_ONLY_FILE [--config-dir DIRECTORY]\n",
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

function ensurePrivateDirectory(path) {
  if (existsSync(path)) {
    const existing = lstatSync(path);
    if (!existing.isDirectory() || existing.isSymbolicLink() || existing.uid !== process.getuid()) {
      throw new Error("The backup directory must be a real directory owned by this user.");
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new Error("The backup directory must be a real directory owned by this user.");
  }
  chmodSync(path, 0o700);
}

function writePrivate(path, content) {
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function escapePasswordField(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function requirePgDump17(directory) {
  const pgDump = join(directory, "pg_dump");
  if (!existsSync(pgDump)) throw new Error("Install the Homebrew libpq formula before configuration.");
  const version = execFileSync(pgDump, ["--version"], { encoding: "utf8" }).trim();
  const major = Number(version.match(/\bpg_dump \(PostgreSQL\) (\d+)/)?.[1]);
  if (!Number.isInteger(major) || major < 17) {
    throw new Error("PostgreSQL client version 17 or newer is required.");
  }
  return version;
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
const passwordStat = lstatSync(passwordPath);
if (!passwordStat.isFile() || passwordStat.isSymbolicLink() || passwordStat.uid !== process.getuid() || (passwordStat.mode & 0o077) !== 0) {
  throw new Error("The database password file must be a regular owner-only file.");
}
const password = readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");
if (password.length === 0 || password.includes("\n") || password.includes("\r")) {
  throw new Error("The database password file must contain one non-empty password line.");
}

const root = options.has("config-dir")
  ? resolve(options.get("config-dir"))
  : join(homedir(), "Library", "Application Support", "TradingJournalBackup");
ensurePrivateDirectory(root);
ensurePrivateDirectory(join(root, "snapshots"));
ensurePrivateDirectory(join(root, "recovery"));

const config = join(root, "config");
const serviceFile = join(root, "pg_service.conf");
const passwordFile = join(root, "pgpass");
const recipientCertificate = join(root, "recipient.crt");
const privateKey = join(root, "recovery", "private-key.pem");
const recoveryPassphrase = join(root, "recovery", "restore-passphrase");
if ([config, serviceFile, passwordFile, recipientCertificate, privateKey, recoveryPassphrase].some(existsSync)) {
  throw new Error("Backup configuration already exists. Review it before making changes.");
}

const pgBinDirectory = execFileSync("brew", ["--prefix", "libpq"], { encoding: "utf8" }).trim() + "/bin";
const opensslBin = execFileSync("brew", ["--prefix", "openssl@4"], { encoding: "utf8" }).trim() + "/bin/openssl";
const pgVersion = requirePgDump17(pgBinDirectory);
if (!existsSync("/etc/ssl/cert.pem")) throw new Error("The macOS system CA bundle is unavailable.");
if (!existsSync(opensslBin)) throw new Error("The Homebrew OpenSSL binary is unavailable.");

const recipientPassword = randomBytes(48).toString("base64url");
const temporaryPassphrase = join(root, ".recovery-passphrase.tmp");
writePrivate(temporaryPassphrase, recipientPassword + "\n");
try {
  const result = spawnSync(opensslBin, [
    "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "3650",
    "-subj", "/CN=personal-trading-journal-backup",
    "-keyout", privateKey, "-passout", `file:${temporaryPassphrase}`,
    "-out", recipientCertificate,
  ], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("Could not generate the backup recipient key.");
} finally {
  const { unlinkSync } = await import("node:fs");
  unlinkSync(temporaryPassphrase);
}

chmodSync(privateKey, 0o600);
chmodSync(recipientCertificate, 0o600);

writePrivate(recoveryPassphrase, recipientPassword + "\n");
const service = [
  "[journal_backup]",
  `host=${host}`,
  "port=5432",
  `dbname=${database}`,
  `user=${role}`,
  "sslmode=verify-full",
  "sslrootcert=/etc/ssl/cert.pem",
  "application_name=personal-trading-journal-backup",
  "",
].join("\n");
writePrivate(serviceFile, service);
writePrivate(passwordFile, `${host}:5432:${database}:${role}:${escapePasswordField(password)}\n`);
writePrivate(config, `PG_BIN_DIR=${pgBinDirectory}\nOPENSSL_BIN=${opensslBin}\n`);
writePrivate(join(root, "recipient.crt.sha256"), execFileSync("shasum", ["-a", "256", recipientCertificate], { encoding: "utf8" }).split(" ")[0] + "\n");

process.stdout.write(`Backup configuration created. ${pgVersion} will be used.\n`);
process.stdout.write(`Private local backup home: ${root}\n`);
process.stdout.write("The daily job will not be loaded or enabled by this command.\n");
process.stdout.write(`Copy these recovery materials to offline storage: ${privateKey} and ${recoveryPassphrase}\n`);
process.stdout.write("Keep both recovery files private and separate from the computer that holds the snapshots.\n");
