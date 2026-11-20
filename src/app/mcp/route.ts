import { createMcpHandler } from '@modelcontextprotocol/server';
import { authenticateBearer } from '@/lib/http';
import { createJournalMcpServer } from '@/lib/mcp-tools';
import { JournalError } from '@/lib/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = createMcpHandler(createJournalMcpServer, {
  legacy: 'stateless',
  maxRequestBodySize: 128 * 1024,
  maxSubscriptions: 0,
});

async function handle(request: Request) {
  const headers = new Headers({ 'Cache-Control': 'private, no-store' });
  try {
    const token = process.env.JOURNAL_MCP_TOKEN;
    if (token && (token === process.env.JOURNAL_API_TOKEN || token === process.env.JOURNAL_WEB_PASSWORD)) {
      throw new JournalError(503, 'AUTH_UNAVAILABLE', 'MCP 需要独立的访问令牌。');
    }
    authenticateBearer(request, token);
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(request.url).origin) {
      throw new JournalError(403, 'INVALID_ORIGIN', '请求来源不受信任。');
    }
    if (request.method !== 'POST') {
      headers.set('Allow', 'POST');
      throw new JournalError(405, 'METHOD_NOT_ALLOWED', '此地址接受 MCP POST 请求。');
    }
    const response = await handler.fetch(request);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    const failure = error instanceof JournalError ? error :
      new JournalError(503, 'SERVICE_UNAVAILABLE', '服务暂时不可用，请使用原幂等键重试。');
    if (failure.status === 401) headers.set('WWW-Authenticate', 'Bearer realm="journal-mcp"');
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: failure.message } },
      { status: failure.status, headers });
  }
}

export { handle as POST, handle as GET, handle as DELETE };
