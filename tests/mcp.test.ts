import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { sql } from "drizzle-orm";

import { startTestDatabase } from "./helper";

type RpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type ToolResult = {
  isError?: boolean;
  structuredContent?: {
    [key: string]: unknown;
    ok?: boolean;
    error?: { code?: string; message?: string };
  };
  content?: Array<{ type: string; text?: string }>;
};

let database: Awaited<ReturnType<typeof startTestDatabase>>;
let route: typeof import("../src/app/mcp/route");
let mcpToken: string;
const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  mcpToken: process.env.JOURNAL_MCP_TOKEN,
  apiToken: process.env.JOURNAL_API_TOKEN,
  webPassword: process.env.JOURNAL_WEB_PASSWORD,
};

function requestHeaders(options: {
  token?: string | null;
  modern?: boolean;
  method?: string;
  name?: string;
  origin?: string;
} = {}) {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  const token = options.token === undefined ? mcpToken : options.token;
  if (token !== undefined && token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.modern) {
    headers.set("mcp-protocol-version", "2026-07-28");
    headers.set("mcp-method", options.method ?? "tools/list");
    if (options.name !== undefined) headers.set("mcp-name", options.name);
  }
  return headers;
}

async function responseJson(response: Response): Promise<RpcResponse> {
  const body = await response.text();
  if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
    const data = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .at(-1);
    assert.ok(data, `MCP response did not contain an SSE data frame: ${body}`);
    return JSON.parse(data) as RpcResponse;
  }
  return body ? (JSON.parse(body) as RpcResponse) : {};
}

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  options: {
    id?: number;
    token?: string | null;
    modern?: boolean;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const id = options.id ?? 1;
  const modernName = method === "tools/call" && typeof params.name === "string"
    ? params.name
    : undefined;
  const headers = requestHeaders({
    token: options.token === undefined ? mcpToken : options.token,
    modern: options.modern,
    method,
    name: modernName,
    origin: options.origin,
  });
  const requestParams = options.modern
    ? {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      }
    : params;
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

  const response = await route.POST(new Request("https://journal.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: requestParams }),
  }));
  return { response, message: await responseJson(response) };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  options: Parameters<typeof rpc>[2] = {},
) {
  const { response, message } = await rpc("tools/call", { name, arguments: args }, options);
  assert.equal(response.status, 200, JSON.stringify(message));
  assert.ok(message.result, JSON.stringify(message));
  return message.result as ToolResult;
}

function valueOf<T extends Record<string, unknown>>(result: ToolResult) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
  return result.structuredContent as T & { ok: true };
}

function failureOf(result: ToolResult, code: string) {
  assert.equal(result.isError, true, JSON.stringify(result));
  if (!result.structuredContent) {
    assert.equal(code, "INVALID_INPUT");
    assert.match(result.content?.[0]?.text ?? "", /Input validation error/);
    return { code, message: result.content?.[0]?.text ?? "" };
  }
  assert.equal(result.structuredContent?.ok, false, JSON.stringify(result));
  assert.equal(result.structuredContent?.error?.code, code, JSON.stringify(result));
  assert.match(result.structuredContent?.error?.message as string, /.+/);
  return result.structuredContent?.error as { code: string; message: string };
}

function createArgs(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "DEMO",
    side: "BUY",
    order_type: "LIMIT",
    limit_price: "12.50",
    quantity: "2",
    idempotency_key: randomUUID(),
    ...overrides,
  };
}

async function createOrder(overrides: Record<string, unknown> = {}) {
  return valueOf<{ order_id: string; event_id: string; replayed: boolean }>(
    await callTool("create_order", createArgs(overrides)),
  );
}

function reviewArgs(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    order_id: orderId,
    idempotency_key: randomUUID(),
    expected_version: 0,
    pre_trade_plan: "Follow the written plan.",
    followed_plan: true,
    execution_review: null,
    deviations: null,
    lessons: "Keep the review factual.",
    ...overrides,
  };
}

async function toolNames(modern = false) {
  if (modern) {
    const { response, message } = await rpc("tools/list", {}, { modern: true });
    assert.equal(response.status, 200, JSON.stringify(message));
    assert.ok(Array.isArray(message.result?.tools));
    return (message.result.tools as Array<{ name: string }>).map((tool) => tool.name);
  }

  const initialization = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "journal-mcp-tests", version: "1.0.0" },
  });
  assert.equal(initialization.response.status, 200, JSON.stringify(initialization.message));
  assert.equal(initialization.message.result?.protocolVersion, "2025-11-25");

  const { response, message } = await rpc("tools/list", {}, {
    headers: { "mcp-protocol-version": "2025-11-25" },
  });
  assert.equal(response.status, 200, JSON.stringify(message));
  assert.ok(Array.isArray(message.result?.tools));
  return (message.result.tools as Array<{ name: string }>).map((tool) => tool.name);
}

before(async () => {
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.connectionString;
  process.env.JOURNAL_MCP_TOKEN = randomBytes(32).toString("hex");
  process.env.JOURNAL_API_TOKEN = randomBytes(32).toString("hex");
  delete process.env.JOURNAL_WEB_PASSWORD;
  mcpToken = process.env.JOURNAL_MCP_TOKEN;
  route = await import("../src/app/mcp/route");
});

beforeEach(async () => {
  await database.db.execute(sql`delete from write_rate_limit`);
});

after(async () => {
  const processDatabase = globalThis as typeof globalThis & {
    journalPool?: { end: () => Promise<void> };
  };
  await processDatabase.journalPool?.end();
  await database?.close();
  if (originalEnvironment.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalEnvironment.databaseUrl;
  if (originalEnvironment.mcpToken === undefined) delete process.env.JOURNAL_MCP_TOKEN;
  else process.env.JOURNAL_MCP_TOKEN = originalEnvironment.mcpToken;
  if (originalEnvironment.apiToken === undefined) delete process.env.JOURNAL_API_TOKEN;
  else process.env.JOURNAL_API_TOKEN = originalEnvironment.apiToken;
  if (originalEnvironment.webPassword === undefined) delete process.env.JOURNAL_WEB_PASSWORD;
  else process.env.JOURNAL_WEB_PASSWORD = originalEnvironment.webPassword;
});

test("MCP endpoint requires its own token for every method and rejects untrusted origins", async () => {
  const unauthenticated = await rpc("tools/list", {}, { token: null });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.message.error?.message, "需要有效的访问令牌。");

  const apiToken = process.env.JOURNAL_API_TOKEN!;
  const wrongToken = await rpc("tools/list", {}, { token: apiToken });
  assert.equal(wrongToken.response.status, 401);

  const badOrigin = await rpc("tools/list", {}, { origin: "https://attacker.example" });
  assert.equal(badOrigin.response.status, 403);

  const get = await route.GET(new Request("https://journal.test/mcp", {
    headers: { authorization: `Bearer ${mcpToken}` },
  }));
  assert.equal(get.status, 405);

  const remove = await route.DELETE(new Request("https://journal.test/mcp", {
    method: "DELETE",
    headers: { authorization: `Bearer ${mcpToken}` },
  }));
  assert.equal(remove.status, 405);

  process.env.JOURNAL_MCP_TOKEN = "";
  const unconfigured = await rpc("tools/list");
  assert.equal(unconfigured.response.status, 503);
  process.env.JOURNAL_MCP_TOKEN = mcpToken;
});

test("legacy and modern MCP requests discover all six tools", async () => {
  const expected = [
    "create_order",
    "record_fill",
    "cancel_order",
    "list_orders",
    "get_order_detail",
    "update_review",
  ];
  assert.deepEqual((await toolNames()).sort(), [...expected].sort());
  assert.deepEqual((await toolNames(true)).sort(), [...expected].sort());
});

test("order tools serialize concurrent creates, replay the same key, and preserve lifecycle facts", async () => {
  const args = createArgs({ symbol: "DEMO-LIFECYCLE", idempotency_key: randomUUID() });
  const [first, retry] = await Promise.all([
    callTool("create_order", args),
    callTool("create_order", args),
  ]);
  const receipts = [valueOf<{ order_id: string; event_id: string; replayed: boolean }>(first),
    valueOf<{ order_id: string; event_id: string; replayed: boolean }>(retry)];
  assert.equal(new Set(receipts.map((receipt) => receipt.order_id)).size, 1);
  assert.equal(new Set(receipts.map((receipt) => receipt.event_id)).size, 1);
  assert.deepEqual(receipts.map((receipt) => receipt.replayed).sort(), [false, true]);

  const changedPayload = await callTool("create_order", { ...args, quantity: "3" });
  failureOf(changedPayload, "IDEMPOTENCY_KEY_REUSED");

  const orderId = receipts[0].order_id;
  const fillArgs = {
    order_id: orderId,
    price: "12.45",
    quantity: "1",
    idempotency_key: randomUUID(),
  };
  const [fill, fillRetry] = await Promise.all([
    callTool("record_fill", fillArgs),
    callTool("record_fill", fillArgs),
  ]);
  const fillReceipts = [
    valueOf<{ event_id: string; replayed: boolean }>(fill),
    valueOf<{ event_id: string; replayed: boolean }>(fillRetry),
  ];
  assert.equal(new Set(fillReceipts.map((receipt) => receipt.event_id)).size, 1);
  assert.deepEqual(fillReceipts.map((receipt) => receipt.replayed).sort(), [false, true]);

  const cancellation = valueOf<{ order_id: string; event_id: string; replayed: boolean }>(
    await callTool("cancel_order", {
      order_id: orderId,
      cancelled_quantity: "1",
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(cancellation.order_id, orderId);

  const detail = valueOf<{ order: Record<string, unknown>; events: Array<Record<string, unknown>> }>(
    await callTool("get_order_detail", { order_id: orderId }),
  );
  assert.equal(detail.order.status, "CANCELLED");
  assert.equal(detail.order.filled_quantity, "1.00000000");
  assert.deepEqual(detail.events.map((event) => event.event_type), ["SUBMITTED", "FILLED", "CANCELLED"]);
});

test("review saves are idempotent, detect changed keys and stale versions, and appear in order detail", async () => {
  const order = await createOrder({ symbol: "DEMO-REVIEW" });
  const firstRequest = reviewArgs(order.order_id, {
    idempotency_key: randomUUID(),
    pre_trade_plan: "First review plan.",
  });
  const [firstResult, retryResult] = await Promise.all([
    callTool("update_review", firstRequest),
    callTool("update_review", firstRequest),
  ]);
  const first = valueOf<{ review_id: string; version: number; replayed: boolean }>(firstResult);
  const retry = valueOf<{ review_id: string; version: number; replayed: boolean }>(retryResult);
  assert.equal(first.review_id, retry.review_id);
  assert.equal(first.version, 1);
  assert.deepEqual([first.replayed, retry.replayed].sort(), [false, true]);

  const nextRequest = reviewArgs(order.order_id, {
    expected_version: 1,
    idempotency_key: randomUUID(),
    pre_trade_plan: "Second review plan.",
  });
  const next = valueOf<{ version: number; replayed: boolean }>(
    await callTool("update_review", nextRequest),
  );
  assert.equal(next.version, 2);

  failureOf(await callTool("update_review", {
    ...firstRequest,
    pre_trade_plan: "Changed original request.",
  }), "IDEMPOTENCY_KEY_REUSED");
  failureOf(await callTool("update_review", reviewArgs(order.order_id, {
    expected_version: 1,
    idempotency_key: randomUUID(),
  })), "REVIEW_VERSION_CONFLICT");
  failureOf(await callTool("update_review", {
    order_id: order.order_id,
    idempotency_key: randomUUID(),
    expected_version: 2,
    pre_trade_plan: "Incomplete snapshot.",
  }), "INVALID_INPUT");

  const detail = valueOf<{
    order: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
    review: Record<string, unknown> | null;
  }>(await callTool("get_order_detail", { order_id: order.order_id }));
  assert.equal(detail.review?.version, 2);
  assert.equal(detail.review?.pre_trade_plan, "Second review plan.");
});

test("writes require explicit fields and order IDs when several symbol matches exist", async () => {
  const first = await createOrder({ symbol: "DEMO-AMBIGUOUS" });
  const second = await createOrder({ symbol: "DEMO-AMBIGUOUS", side: "SELL" });

  failureOf(await callTool("create_order", {
    symbol: "DEMO-MISSING",
    side: "BUY",
    idempotency_key: randomUUID(),
  }), "INVALID_INPUT");

  failureOf(await callTool("record_fill", {
    symbol: "DEMO-AMBIGUOUS",
    price: "12.50",
    quantity: "1",
    idempotency_key: randomUUID(),
  }), "INVALID_INPUT");

  const firstDetail = valueOf<{ events: Array<Record<string, unknown>> }>(
    await callTool("get_order_detail", { order_id: first.order_id }),
  );
  const secondDetail = valueOf<{ events: Array<Record<string, unknown>> }>(
    await callTool("get_order_detail", { order_id: second.order_id }),
  );
  assert.equal(firstDetail.events.length, 1);
  assert.equal(secondDetail.events.length, 1);
});

test("fill rules reject overfills and additional fills after terminal state", async () => {
  const order = await createOrder({ symbol: "DEMO-TERMINAL", quantity: "1" });
  failureOf(await callTool("record_fill", {
    order_id: order.order_id,
    price: "12.50",
    quantity: "2",
    idempotency_key: randomUUID(),
  }), "FILL_EXCEEDS_ORDER");

  await callTool("record_fill", {
    order_id: order.order_id,
    price: "12.50",
    quantity: "1",
    idempotency_key: randomUUID(),
  });
  failureOf(await callTool("record_fill", {
    order_id: order.order_id,
    price: "12.50",
    quantity: "0.5",
    idempotency_key: randomUUID(),
  }), "ORDER_NOT_OPEN");
});

test("order and review write limits are enforced inside tool calls", async () => {
  await database.db.execute(sql`
    insert into write_rate_limit (id, window_start, hits)
    values (1, date_trunc('minute', statement_timestamp()) + interval '1 minute', 59)
    on conflict (id) do update set
      window_start = date_trunc('minute', statement_timestamp()) + interval '1 minute', hits = 59
  `);
  valueOf(await callTool("create_order", createArgs({ symbol: "DEMO-RATE" })));
  failureOf(await callTool("create_order", createArgs({ symbol: "DEMO-RATE-2" })), "RATE_LIMITED");

  await database.db.execute(sql`delete from write_rate_limit where id = 1`);
  await database.db.execute(sql`
    insert into write_rate_limit (id, window_start, hits)
    values (3, date_trunc('minute', statement_timestamp()) + interval '1 minute', 29)
    on conflict (id) do update set
      window_start = date_trunc('minute', statement_timestamp()) + interval '1 minute', hits = 29
  `);
  const order = await createOrder({ symbol: "DEMO-RATE-REVIEW" });
  valueOf(await callTool("update_review", reviewArgs(order.order_id)));
  failureOf(await callTool("update_review", reviewArgs(order.order_id, {
    expected_version: 1,
  })), "RATE_LIMITED");
});

test("the endpoint rejects oversized requests before MCP dispatch", async () => {
  const response = await route.POST(new Request("https://journal.test/mcp", {
    method: "POST",
    headers: requestHeaders(),
    body: "x".repeat(129 * 1024),
  }));
  assert.equal(response.status, 413);
});
