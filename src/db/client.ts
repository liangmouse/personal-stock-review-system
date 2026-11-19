import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

type Database = NodePgDatabase<typeof schema>;

type DatabaseCache = typeof globalThis & {
  journalPool?: Pool;
  journalDb?: Database;
};

const databaseCache = globalThis as DatabaseCache;

export function getDb(): Database {
  if (databaseCache.journalDb) {
    return databaseCache.journalDb;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required to connect to the database.");
  }

  const databaseUrl = new URL(connectionString);
  const sslMode = databaseUrl.searchParams.get("sslmode");
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const configuredHost = databaseUrl.searchParams.get("host") ?? databaseUrl.hostname;
  const isLoopback = configuredHost.startsWith("/") || loopbackHosts.has(configuredHost);

  // pg's URL parser overrides `ssl` when sslmode or certificate options remain in
  // the connection string. Apply TLS settings here so remote connections always
  // verify certificates, while local test databases can explicitly disable TLS.
  databaseUrl.searchParams.delete("sslmode");
  databaseUrl.searchParams.delete("ssl");
  databaseUrl.searchParams.delete("sslrootcert");
  databaseUrl.searchParams.delete("sslcert");
  databaseUrl.searchParams.delete("sslkey");

  const ssl = isLoopback && (sslMode === "disable" || sslMode === null)
    ? false
    : { rejectUnauthorized: true };

  const pool = databaseCache.journalPool ?? new Pool({
    connectionString: databaseUrl.toString(),
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    ssl,
  });
  pool.on("error", () => {
    console.error("An idle database connection was dropped.");
  });

  databaseCache.journalPool = pool;
  databaseCache.journalDb = drizzle(pool, { schema });

  return databaseCache.journalDb;
}
