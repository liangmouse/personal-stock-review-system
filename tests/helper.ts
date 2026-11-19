import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import * as schema from "../src/db/schema";

type Database = NodePgDatabase<typeof schema>;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a local PostgreSQL port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

export async function startTestDatabase(): Promise<{
  db: Database;
  connectionString: string;
  close: () => Promise<void>;
}> {
  const databaseDir = await mkdtemp(join(tmpdir(), "trading-journal-pg-"));
  const port = await unusedPort();
  const password = randomBytes(32).toString("hex");
  const postgres = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password,
    port,
    persistent: false,
    autoRehydrateSymlinks: true,
    onLog: () => undefined,
    onError: () => undefined,
  });

  let pool: Pool | undefined;
  try {
    await postgres.initialise();
    await postgres.start();

    const connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`;
    pool = new Pool({ connectionString, max: 5 });
    const db = drizzle(pool, { schema });

    await migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });

    let closed = false;
    return {
      db,
      connectionString,
      close: async () => {
        if (closed) return;
        closed = true;
        await pool?.end();
        await postgres.stop();
        await rm(databaseDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(databaseDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
