import { getDb } from '@/db/client';
import {
  exchangeAuthorizationCode,
  oauthClientId,
  OAuthStoreError,
  pruneExpiredOAuthState,
  rotateRefreshToken,
  verifyOAuthClientSecret,
} from '@/lib/oauth-store';
import {
  noStoreHeaders,
  oauthAuthorizationVersion,
  oauthIssuer,
  oauthResource,
} from '@/lib/oauth-http';
import { hasValidWebPassword } from '@/lib/session-token';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const requestBodyLimit = 16 * 1024;

function oauthError(error: string, status: number, headers?: HeadersInit) {
  return Response.json({ error }, {
    status,
    headers: { ...noStoreHeaders(), ...Object.fromEntries(new Headers(headers).entries()) },
  });
}

async function readForm(request: Request) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') return null;
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > requestBodyLimit) return null;
  const reader = request.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > requestBodyLimit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

function oneValue(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function decodeBasicCredentials(header: string | null) {
  if (header === null) return null;
  const encoded = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header)?.[1];
  if (!encoded) return null;
  try {
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return null;
    const decoded = buffer.toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    const decodeFormPart = (value: string) => decodeURIComponent(value.replace(/\+/g, ' '));
    return {
      clientId: decodeFormPart(decoded.slice(0, separator)),
      secret: decodeFormPart(decoded.slice(separator + 1)),
    };
  } catch {
    return null;
  }
}

function clientCredentials(request: Request, form: URLSearchParams) {
  const basic = decodeBasicCredentials(request.headers.get('authorization'));
  const bodyClientId = oneValue(form, 'client_id');
  const bodySecret = oneValue(form, 'client_secret');
  if (request.headers.has('authorization') && basic === null) return null;
  if (basic) {
    if (form.has('client_secret') || form.getAll('client_id').length > 1) return null;
    if (bodyClientId !== null && bodyClientId !== basic.clientId) return null;
    return basic;
  }
  if (bodyClientId === null || bodySecret === null) return null;
  return { clientId: bodyClientId, secret: bodySecret };
}

export async function POST(request: Request) {
  const origin = oauthIssuer();
  if (!origin || !oauthResource()) return oauthError('server_error', 503);
  if (request.headers.has('origin') && request.headers.get('origin') !== origin) {
    return oauthError('invalid_request', 400);
  }

  let form: URLSearchParams | null;
  try {
    form = await readForm(request);
  } catch {
    return oauthError('invalid_request', 400);
  }
  if (!form) return oauthError('invalid_request', 400);
  const credentials = clientCredentials(request, form);
  if (!credentials || credentials.clientId !== oauthClientId) {
    return oauthError('invalid_client', 401, { 'WWW-Authenticate': 'Basic realm="journal-oauth"' });
  }
  const expectedClientSecret = process.env.JOURNAL_OAUTH_CLIENT_SECRET;
  if (!verifyOAuthClientSecret(credentials.secret, expectedClientSecret)) {
    return oauthError('invalid_client', 401, { 'WWW-Authenticate': 'Basic realm="journal-oauth"' });
  }
  if (!hasValidWebPassword(process.env.JOURNAL_WEB_PASSWORD)) {
    return oauthError('server_error', 503);
  }

  const grantType = oneValue(form, 'grant_type');
  const resource = oneValue(form, 'resource');
  const expectedResource = oauthResource();
  if (!expectedResource || resource !== expectedResource) return oauthError('invalid_target', 400);

  try {
    const version = oauthAuthorizationVersion();
    if (!version) return oauthError('server_error', 503);
    const db = getDb();
    await pruneExpiredOAuthState(db);
    if (grantType === 'authorization_code') {
      const code = oneValue(form, 'code');
      const redirectUri = oneValue(form, 'redirect_uri');
      const codeVerifier = oneValue(form, 'code_verifier');
      if (!code || !redirectUri || !codeVerifier) return oauthError('invalid_request', 400);
      const tokens = await exchangeAuthorizationCode(db, {
        code,
        clientId: credentials.clientId,
        redirectUri,
        codeVerifier,
        resource,
        authorizationVersion: version,
      });
      return Response.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
        scope: tokens.scope,
      }, { headers: noStoreHeaders() });
    }
    if (grantType === 'refresh_token') {
      const refreshToken = oneValue(form, 'refresh_token');
      if (!refreshToken) return oauthError('invalid_request', 400);
      const tokens = await rotateRefreshToken(db, {
        refreshToken,
        clientId: credentials.clientId,
        resource,
        authorizationVersion: version,
      });
      if (!tokens) return oauthError('invalid_grant', 400);
      return Response.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
        scope: tokens.scope,
      }, { headers: noStoreHeaders() });
    }
    return oauthError('unsupported_grant_type', 400);
  } catch (error) {
    if (error instanceof OAuthStoreError) return oauthError(error.code, 400);
    return oauthError('server_error', 503);
  }
}
