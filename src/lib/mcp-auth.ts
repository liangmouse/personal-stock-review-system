import { createHash, timingSafeEqual } from 'node:crypto';

import { getDb } from '@/db/client';
import { oauthClientId, verifyAccessToken } from '@/lib/oauth-store';
import {
  isOAuthConfigurationReady,
  oauthAuthorizationVersion,
  oauthIssuer,
  oauthResource,
} from '@/lib/oauth-http';

export type McpAuthorizationResult =
  | { authorized: true }
  | { authorized: false; status: 401 | 503; message: string; challenge?: string };

function equalSecret(supplied: string, expected: string) {
  return timingSafeEqual(
    createHash('sha256').update(supplied).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function challenge() {
  const issuer = oauthIssuer();
  const resource = oauthResource();
  if (!issuer || !resource) return undefined;
  const metadata = `${issuer}/.well-known/oauth-protected-resource/mcp`;
  return `Bearer resource_metadata="${metadata}", scope="journal"`;
}

export async function authorizeMcpRequest(request: Request): Promise<McpAuthorizationResult> {
  const apiToken = process.env.JOURNAL_API_TOKEN;
  const webPassword = process.env.JOURNAL_WEB_PASSWORD;
  const staticToken = process.env.JOURNAL_MCP_TOKEN;
  if (staticToken && (staticToken === apiToken || staticToken === webPassword)) {
    return { authorized: false, status: 503, message: 'MCP 需要独立的访问令牌。' };
  }
  if (staticToken && !/^[!-~]{32,}$/.test(staticToken)) {
    return { authorized: false, status: 503, message: 'MCP 令牌尚未正确配置。' };
  }

  const supplied = /^Bearer ([!-~]{32,})$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!supplied) {
    if (!staticToken && !isOAuthConfigurationReady()) {
      return { authorized: false, status: 503, message: 'MCP 身份验证尚未配置。' };
    }
    const authChallenge = challenge();
    return {
      authorized: false,
      status: 401,
      message: '需要有效的 MCP 访问令牌。',
      ...(authChallenge ? { challenge: authChallenge } : {}),
    };
  }

  if (staticToken && equalSecret(supplied, staticToken)) return { authorized: true };

  const version = isOAuthConfigurationReady() && webPassword ? oauthAuthorizationVersion() : null;
  const resource = oauthResource();
  if (version && resource) {
    const access = await verifyAccessToken(getDb(), supplied, {
      clientId: oauthClientId,
      resource,
      authorizationVersion: version,
    });
    if (access?.scope.split(/\s+/).includes('journal')) return { authorized: true };
  }

  if (!staticToken && !isOAuthConfigurationReady()) {
    return { authorized: false, status: 503, message: 'MCP 身份验证尚未配置。' };
  }
  const authChallenge = challenge();
  return {
    authorized: false,
    status: 401,
    message: '需要有效的 MCP 访问令牌。',
    ...(authChallenge ? { challenge: authChallenge } : {}),
  };
}
