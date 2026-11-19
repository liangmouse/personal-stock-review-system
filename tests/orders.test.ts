import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { sql } from "drizzle-orm";

import * as dbSchema from "../src/db/schema";
import { startTestDatabase } from "./helper";

type TestResponse = {
  ok: boolean;
  order_id?: string;
  event_id?: string;
  replayed?: boolean;
  order?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
  items?: Array<Record<string, unknown>>;
  error?: { code: string; message: string };
};

let db: Awaited<ReturnType<typeof startTestDatabase>>["db"];
let closeDatabase: (() => Promise<void>) | undefined;
let token: string;
let ordersRoute: typeof import("../src/app/api/orders/route");
let detailRoute: typeof import("../src/app/api/orders/[id]/route");
let fillsRoute: typeof import("../src/app/api/orders/[id]/fills/route");
let cancelRoute: typeof import("../src/app/api/orders/[id]/cancel/route");

function authHeaders(extra: Record<string, string> = {}) {
  return new Headers({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...extra,
  });
}

function postRequest(
  path: string,
  body: unknown,
  headers: HeadersInit = authHeaders(),
) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function readResponse(response: Response): Promise<TestResponse> {
  return (await response.json()) as TestResponse;
}

function errorHasCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === code || errorHasCode(candidate.cause, code);
}

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "DEMO",
    side: "BUY",
    order_type: "LIMIT",
    limit_price: "123.45000000",
    quantity: "2",
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

async function createOrder(overrides: Record<string, unknown> = {}) {
  const response = await ordersRoute.POST(
    postRequest("/api/orders", createBody(overrides)),
  );
  const payload = await readResponse(response);
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.ok(payload.order_id);
  assert.ok(payload.event_id);
  assert.equal(payload.replayed, false);
  return { orderId: payload.order_id, eventId: payload.event_id };
}

async function fillOrder(
  orderId: string,
  body: Record<string, unknown>,
) {
  return fillsRoute.POST(
    postRequest(`/api/orders/${orderId}/fills`, body),
    { params: Promise.resolve({ id: orderId }) },
  );
}

async function cancelOrder(
  orderId: string,
  body: Record<string, unknown>,
) {
  return cancelRoute.POST(
    postRequest(`/api/orders/${orderId}/cancel`, body),
    { params: Promise.resolve({ id: orderId }) },
  );
}

async function getOrder(orderId: string) {
  const response = await detailRoute.GET(
    new Request(`http://localhost/api/orders/${orderId}`, {
      headers: authHeaders(),
    }),
    { params: Promise.resolve({ id: orderId }) },
  );
  return { response, payload: await readResponse(response) };
}

before(async () => {
  token = randomBytes(32).toString("hex");
  process.env.JOURNAL_API_TOKEN = token;

  const testDatabase = await startTestDatabase();
  db = testDatabase.db;
  closeDatabase = testDatabase.close;
  process.env.DATABASE_URL = testDatabase.connectionString;

  // Route handlers resolve the same lazy database client as production. Point
  // its global cache at this isolated PostgreSQL-backed Drizzle connection.
  const databaseCache = globalThis as typeof globalThis & {
    journalDb?: typeof db;
    journalPool?: unknown;
  };
  databaseCache.journalDb = db;

  ordersRoute = await import("../src/app/api/orders/route");
  detailRoute = await import("../src/app/api/orders/[id]/route");
  fillsRoute = await import("../src/app/api/orders/[id]/fills/route");
  cancelRoute = await import("../src/app/api/orders/[id]/cancel/route");
});

beforeEach(async () => {
  await db.execute(sql.raw("DELETE FROM write_rate_limit"));
});

after(async () => {
  const databaseCache = globalThis as typeof globalThis & {
    journalDb?: typeof db;
    journalPool?: unknown;
  };
  delete databaseCache.journalDb;
  delete databaseCache.journalPool;
  delete process.env.DATABASE_URL;
  delete process.env.JOURNAL_API_TOKEN;
  await closeDatabase?.();
});

test("input schemas require exact decimal strings and explicit offset timestamps", async () => {
  const { createOrderInput } = await import("../src/lib/input");
  const valid = createBody({ occurred_at: "2001-02-03T03:04:05.123Z" });

  assert.equal(createOrderInput.safeParse(valid).success, true);
  assert.equal(
    createOrderInput.safeParse({ ...valid, quantity: 2 }).success,
    false,
  );
  assert.equal(
    createOrderInput.safeParse({ ...valid, quantity: "1.123456789" }).success,
    false,
  );
  assert.equal(
    createOrderInput.safeParse({ ...valid, occurred_at: "2001-02-03T03:04:05" })
      .success,
    false,
  );
  assert.equal(
    createOrderInput.safeParse({ ...valid, extra: "ignored fields are unsafe" })
      .success,
    false,
  );
  assert.equal(
    createOrderInput.safeParse({
      ...valid,
      order_type: "LIMIT",
      limit_price: undefined,
    }).success,
    false,
  );
});

test("create, partial fill, and cancel preserve the filled amount and event facts", async () => {
  const { orderId } = await createOrder({ quantity: "2.00000000" });

  const fill = await fillOrder(orderId, {
    price: "123.44000000",
    quantity: "0.75000000",
    idempotency_key: randomUUID(),
  });
  assert.equal(fill.status, 201);

  const cancellation = await cancelOrder(orderId, {
    cancelled_quantity: "1.25000000",
    idempotency_key: randomUUID(),
  });
  assert.equal(cancellation.status, 201);

  const { response, payload } = await getOrder(orderId);
  assert.equal(response.status, 200);
  assert.equal(payload.order?.status, "CANCELLED");
  assert.equal(payload.order?.quantity, "2.00000000");
  assert.equal(payload.order?.filled_quantity, "0.75000000");
  assert.equal(payload.events?.length, 3);
  assert.deepEqual(
    payload.events?.map((event) => event.event_type),
    ["SUBMITTED", "FILLED", "CANCELLED"],
  );
  assert.deepEqual(
    payload.events?.map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.equal(payload.events?.[0].occurred_at, null);
  assert.equal(payload.events?.[1].occurred_at, null);
  assert.equal(payload.events?.[2].occurred_at, null);
  assert.ok(payload.events?.every((event) => event.recorded_at));
  assert.equal(payload.events?.[1].price, "123.44000000");
  assert.equal(payload.events?.[1].quantity, "0.75000000");
  assert.equal(payload.events?.[2].quantity, "1.25000000");
});

test("completed orders reject further fills and do not exceed the requested quantity", async () => {
  const { orderId } = await createOrder({ quantity: "1" });

  const fullFill = await fillOrder(orderId, {
    price: "123.45",
    quantity: "1",
    idempotency_key: randomUUID(),
  });
  assert.equal(fullFill.status, 201);

  const lateFill = await fillOrder(orderId, {
    price: "123.44",
    quantity: "0.1",
    idempotency_key: randomUUID(),
  });
  assert.equal(lateFill.status, 409);

  const { payload } = await getOrder(orderId);
  assert.equal(payload.order?.status, "FILLED");
  assert.equal(payload.order?.filled_quantity, "1.00000000");
  assert.equal(payload.events?.length, 2);
});

test("same idempotency key replays the receipt and rejects a changed payload", async () => {
  const body = createBody({ idempotency_key: randomUUID() });
  const first = await ordersRoute.POST(postRequest("/api/orders", body));
  const firstPayload = await readResponse(first);
  const replay = await ordersRoute.POST(postRequest("/api/orders", body));
  const replayPayload = await readResponse(replay);

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replayPayload.replayed, true);
  assert.equal(replayPayload.order_id, firstPayload.order_id);
  assert.equal(replayPayload.event_id, firstPayload.event_id);

  const conflict = await ordersRoute.POST(
    postRequest("/api/orders", { ...body, quantity: "3" }),
  );
  assert.equal(conflict.status, 409);

  const detail = await getOrder(firstPayload.order_id!);
  assert.equal(detail.payload.events?.length, 1);
});

test("a completed fill replays before checking the order's terminal state", async () => {
  const { orderId } = await createOrder({ quantity: "1" });
  const body = {
    price: "123.45",
    quantity: "1",
    idempotency_key: randomUUID(),
  };

  const [first, replay] = await Promise.all([
    fillOrder(orderId, body),
    fillOrder(orderId, body),
  ]);
  const firstPayload = await readResponse(first);
  const replayPayload = await readResponse(replay);

  assert.deepEqual(
    [first.status, replay.status].sort(),
    [200, 201],
  );
  assert.equal(replayPayload.order_id, firstPayload.order_id);
  assert.equal(replayPayload.event_id, firstPayload.event_id);
  assert.equal(
    [firstPayload.replayed, replayPayload.replayed].filter(Boolean).length,
    1,
  );

  const afterCompletion = await fillOrder(orderId, body);
  const afterCompletionPayload = await readResponse(afterCompletion);
  assert.equal(afterCompletion.status, 200);
  assert.equal(afterCompletionPayload.event_id, firstPayload.event_id);

  const changedPayload = await fillOrder(orderId, { ...body, price: "123.44" });
  assert.equal(changedPayload.status, 409);
  const { payload } = await getOrder(orderId);
  assert.equal(payload.order?.status, "FILLED");
  assert.equal(payload.events?.length, 2);
});

test("cancel quantity must match the remaining unfilled amount", async () => {
  const { orderId } = await createOrder({ quantity: "2" });
  const fill = await fillOrder(orderId, {
    price: "123.45",
    quantity: "0.5",
    idempotency_key: randomUUID(),
  });
  assert.equal(fill.status, 201);

  const mismatch = await cancelOrder(orderId, {
    cancelled_quantity: "1",
    idempotency_key: randomUUID(),
  });
  assert.equal(mismatch.status, 409);

  const correct = await cancelOrder(orderId, {
    cancelled_quantity: "1.5",
    idempotency_key: randomUUID(),
  });
  assert.equal(correct.status, 201);
  const lateFill = await fillOrder(orderId, {
    price: "123.45",
    quantity: "0.5",
    idempotency_key: randomUUID(),
  });
  assert.equal(lateFill.status, 409);
  const { payload } = await getOrder(orderId);
  assert.equal(payload.order?.status, "CANCELLED");
  assert.equal(payload.order?.filled_quantity, "0.50000000");
});

test("concurrent duplicate creates produce one order and one replay", async () => {
  const body = createBody({ idempotency_key: randomUUID() });
  const responses = await Promise.all([
    ordersRoute.POST(postRequest("/api/orders", body)),
    ordersRoute.POST(postRequest("/api/orders", body)),
  ]);
  const payloads = await Promise.all(responses.map(readResponse));

  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 201],
  );
  assert.equal(payloads[0].order_id, payloads[1].order_id);
  assert.equal(payloads[0].event_id, payloads[1].event_id);
  assert.equal(payloads.filter((payload) => payload.replayed).length, 1);

  const count = await db.execute(
    sql`select count(*)::int as total from orders where id = ${payloads[0].order_id}`,
  );
  assert.equal(Number(count.rows[0]?.total), 1);
});

test("concurrent fills serialize and cannot overfill an order", async () => {
  const { orderId } = await createOrder({ quantity: "1" });
  const fills = await Promise.all([
    fillOrder(orderId, {
      price: "123.45",
      quantity: "0.75",
      idempotency_key: randomUUID(),
    }),
    fillOrder(orderId, {
      price: "123.44",
      quantity: "0.75",
      idempotency_key: randomUUID(),
    }),
  ]);

  assert.deepEqual(
    fills.map((response) => response.status).sort(),
    [201, 409],
  );
  const { payload } = await getOrder(orderId);
  assert.equal(payload.order?.status, "PARTIALLY_FILLED");
  assert.equal(payload.order?.filled_quantity, "0.75000000");
  assert.equal(payload.events?.length, 2);
});

test("failed event insertion rolls back the order state update", async () => {
  const { orderId } = await createOrder({ quantity: "1" });
  await db.execute(
    sql.raw(`
      CREATE FUNCTION reject_test_fill_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'FILLED' THEN
          RAISE EXCEPTION 'forced event insertion failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_fill_event_trigger
      BEFORE INSERT ON order_events
      FOR EACH ROW EXECUTE FUNCTION reject_test_fill_event();
    `),
  );

  try {
    const fill = await fillOrder(orderId, {
      price: "123.45",
      quantity: "0.5",
      idempotency_key: randomUUID(),
    });
    assert.equal(fill.status, 503);

    const { payload } = await getOrder(orderId);
    assert.equal(payload.order?.status, "OPEN");
    assert.equal(payload.order?.filled_quantity, "0.00000000");
    assert.equal(payload.events?.length, 1);
  } finally {
    await db.execute(
      sql.raw(
        "DROP TRIGGER IF EXISTS reject_test_fill_event_trigger ON order_events; DROP FUNCTION IF EXISTS reject_test_fill_event();",
      ),
    );
  }
});

test("list filters and detail show the events associated with each order", async () => {
  await createOrder({
    symbol: "aa",
    side: "BUY",
    occurred_at: "2001-02-03T00:00:00.000Z",
  });
  await createOrder({
    symbol: "BB",
    side: "SELL",
    occurred_at: "2001-02-04T00:00:00.000Z",
  });

  const response = await ordersRoute.GET(
    new Request(
      "http://localhost/api/orders?symbol=AA&side=BUY&from=2001-02-03T00%3A00%3A00.000Z&to=2001-02-04T00%3A00%3A00.000Z",
      { headers: authHeaders() },
    ),
  );
  const payload = await readResponse(response);
  assert.equal(response.status, 200);
  assert.equal(payload.items?.length, 1);
  assert.equal(payload.items?.[0].symbol, "AA");
  assert.equal(payload.items?.[0].side, "BUY");
});

test("authenticated writes enforce the body limit and shared rate limit", async () => {
  const oversized = await ordersRoute.POST(
    new Request("http://localhost/api/orders", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...createBody(), padding: "x".repeat(17_000) }),
    }),
  );
  assert.equal(oversized.status, 413);

  await db.execute(
    sql`insert into write_rate_limit (id, window_start, hits)
      values (1, date_trunc('minute', statement_timestamp()), 59)
      on conflict (id) do update
        set window_start = excluded.window_start, hits = excluded.hits`,
  );
  const lastAllowed = await ordersRoute.POST(
    postRequest("/api/orders", createBody()),
  );
  assert.equal(lastAllowed.status, 201);
  const blocked = await ordersRoute.POST(
    postRequest("/api/orders", createBody()),
  );
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "60");
});

test("reads and writes require the configured bearer token", async () => {
  const noAuth = new Request("http://localhost/api/orders", {
    headers: { "content-type": "application/json" },
  });
  const response = await ordersRoute.GET(noAuth);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");

  const wrongToken = await ordersRoute.POST(
    postRequest("/api/orders", createBody(), {
      authorization: `Bearer ${randomBytes(32).toString("hex")}`,
      "content-type": "application/json",
    }),
  );
  assert.equal(wrongToken.status, 401);

  const secret = process.env.JOURNAL_API_TOKEN;
  process.env.JOURNAL_API_TOKEN = "too-short";
  try {
    const unavailable = await ordersRoute.GET(
      new Request("http://localhost/api/orders", { headers: authHeaders() }),
    );
    assert.equal(unavailable.status, 503);
  } finally {
    process.env.JOURNAL_API_TOKEN = secret;
  }
});

test("PostgreSQL rejects invalid persisted values", async () => {
  await assert.rejects(
    db.execute(sql`
      insert into orders (symbol, side, quantity, filled_quantity, status)
      values ('BAD SYMBOL', 'BUY', '1', '0', 'OPEN')
    `),
    (error: unknown) => errorHasCode(error, "23514"),
  );

  const { orderId } = await createOrder({ quantity: "1" });
  await assert.rejects(
    db.insert(dbSchema.orderEvents).values({
      orderId,
      sequence: 2,
      eventType: "FILLED",
      price: null,
      quantity: "1",
      idempotencyKey: randomUUID(),
      requestHash: "a".repeat(64),
    }),
    (error: unknown) => errorHasCode(error, "23514"),
  );
});

test("persisted order events reject update, delete, and truncate", async () => {
  const { orderId, eventId } = await createOrder();

  await assert.rejects(
    db.execute(
      sql`update order_events set note = 'rewritten' where id = ${eventId}`,
    ),
  );
  await assert.rejects(
    db.execute(sql`delete from order_events where id = ${eventId}`),
  );
  await assert.rejects(db.execute(sql.raw("TRUNCATE TABLE order_events")));

  const detail = await getOrder(orderId);
  assert.equal(detail.payload.events?.length, 1);
  assert.equal(detail.payload.events?.[0].id, eventId);
});
