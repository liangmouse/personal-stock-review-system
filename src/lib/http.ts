import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { writeRateLimit } from '../db/schema';
import { getOrderDetail, JournalError, listOrders, writeOrder } from './orders';

const bodyLimit = 16 * 1024;
const writesPerMinute = 60;
export type OrderRoute = { params: Promise<{ id: string }> };

function authenticate(request: Request) {
  const token = process.env.JOURNAL_API_TOKEN;
  if (!token || !/^[!-~]{32,}$/.test(token)) {
    throw new JournalError(503, 'AUTH_UNAVAILABLE', '服务端认证尚未配置。');
  }
  const supplied = /^Bearer ([!-~]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!supplied || !timingSafeEqual(digest(supplied), digest(token))) {
    throw new JournalError(401, 'UNAUTHORIZED', '需要有效的访问令牌。');
  }
}

async function countWriteAttempt() {
  const minute = sql`date_trunc('minute', statement_timestamp())`;
  // A single UPSERT shares the budget across instances. An older waiting request
  // cannot move the active window backwards after the minute rolls over.
  const counter = writeRateLimit;
  const [accepted] = await getDb().insert(counter).values({ id: 1, windowStart: minute, hits: 1 })
    .onConflictDoUpdate({
      target: counter.id,
      set: {
        windowStart: sql`greatest(${counter.windowStart}, ${minute})`,
        hits: sql`case when ${counter.windowStart} < ${minute} then 1 else ${counter.hits} + 1 end`,
      },
      setWhere: sql`${counter.windowStart} < ${minute} or ${counter.hits} < ${writesPerMinute}`,
    }).returning({ hits: counter.hits });
  if (!accepted) throw new JournalError(429, 'RATE_LIMITED', '写入过于频繁，请稍后重试。');
}

async function readJson(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new JournalError(415, 'JSON_REQUIRED', '请使用 application/json。');
  }
  const tooLarge = () => new JournalError(413, 'BODY_TOO_LARGE', '请求体上限为 16 KiB。');
  if (Number(request.headers.get('content-length')) > bodyLimit) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new JournalError(400, 'INVALID_JSON', '请求体为空。');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > bodyLimit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof JournalError) throw error;
    throw new JournalError(400, 'INVALID_JSON', '请求体必须是有效的 UTF-8 JSON。');
  } finally {
    reader.releaseLock();
  }
}

function json(body: unknown, status = 200) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  if (status === 401) headers.set('WWW-Authenticate', 'Bearer');
  if (status === 429) headers.set('Retry-After', '60');
  return Response.json(body, { status, headers });
}

async function authenticated(request: Request, action: () => Promise<Response>) {
  try {
    authenticate(request);
    return await action();
  } catch (error) {
    // Database errors can include query parameters, credentials or journal text.
    const failure = error instanceof JournalError ? error :
      new JournalError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用，请使用原幂等键重试。');
    return json({ ok: false, error: { code: failure.code, message: failure.message } }, failure.status);
  }
}

export function writeResponse(request: Request, kind: 'create' | 'fill' | 'cancel', route?: OrderRoute) {
  return authenticated(request, async () => {
    await countWriteAttempt();
    const orderId = (await route?.params)?.id;
    const body = await readJson(request);
    const receipt = await writeOrder(getDb(), { kind, orderId, body });
    return json({ ok: true, ...receipt }, receipt.replayed ? 200 : 201);
  });
}

export function ordersResponse(request: Request) {
  return authenticated(request, async () => {
    const query: Record<string, string> = Object.create(null);
    for (const [key, value] of new URL(request.url).searchParams) {
      if (Object.hasOwn(query, key)) throw new JournalError(400, 'DUPLICATE_FILTER', '同一筛选条件只能传一次。');
      query[key] = value;
    }
    return json({ ok: true, ...await listOrders(getDb(), query) });
  });
}

export function detailResponse(request: Request, route: OrderRoute) {
  return authenticated(request, async () => {
    const { id } = await route.params;
    return json({ ok: true, ...await getOrderDetail(getDb(), id) });
  });
}
