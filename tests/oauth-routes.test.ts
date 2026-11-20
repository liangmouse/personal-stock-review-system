import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';

import {
  authorizationVersion,
  chatGptRedirectUri,
  createAuthorizationCode,
  oauthClientId,
} from '../src/lib/oauth-store';
import { startTestDatabase } from './helper';

const originalEnvironment = {
  databaseUrl: process.env.DATABASE_URL,
  publicOrigin: process.env.JOURNAL_PUBLIC_ORIGIN,
  clientSecret: process.env.JOURNAL_OAUTH_CLIENT_SECRET,
  webPassword: process.env.JOURNAL_WEB_PASSWORD,
  mcpToken: process.env.JOURNAL_MCP_TOKEN,
  apiToken: process.env.JOURNAL_API_TOKEN,
};

const testPassword = 'isolated-oauth-web-password-for-route-tests';
const testClientSecret = 'isolated-oauth-client-secret-for-route-tests';
const testVerifier = randomBytes(32).toString('base64url');
const testChallenge = createHash('sha256').update(testVerifier).digest('base64url');
const testResource = 'https://journal.example/mcp';
const testOrigin = 'https://journal.example';

let database: Awaited<ReturnType<typeof startTestDatabase>>;
let tokenRoute: typeof import('../src/app/oauth/token/route');
let mcpRoute: typeof import('../src/app/mcp/route');
let authorizationVersionForTest: string;

function tokenRequest(body: Record<string, string>, headers: Record<string, string> = {}) {
  return tokenRoute.POST(new Request(`${testOrigin}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(body),
  }));
}

function basicHeader() {
  return `Basic ${Buffer.from(`${encodeURIComponent(oauthClientId)}:${encodeURIComponent(testClientSecret)}`).toString('base64')}`;
}

async function issueCode(scope = 'journal offline_access') {
  return createAuthorizationCode(database.db, {
    clientId: oauthClientId,
    redirectUri: chatGptRedirectUri,
    scope,
    resource: testResource,
    codeChallenge: testChallenge,
    codeChallengeMethod: 'S256',
    authorizationVersion: authorizationVersionForTest,
  });
}

async function exchange(code: string, headers: Record<string, string> = {}) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: chatGptRedirectUri,
    code_verifier: testVerifier,
    resource: testResource,
    client_id: oauthClientId,
    ...(!headers.authorization ? {
      client_secret: testClientSecret,
    } : {}),
  }, headers);
}

before(async () => {
  process.env.JOURNAL_PUBLIC_ORIGIN = testOrigin;
  process.env.JOURNAL_OAUTH_CLIENT_SECRET = testClientSecret;
  process.env.JOURNAL_WEB_PASSWORD = testPassword;
  process.env.JOURNAL_MCP_TOKEN = randomBytes(32).toString('hex');
  process.env.JOURNAL_API_TOKEN = randomBytes(32).toString('hex');
  authorizationVersionForTest = authorizationVersion(`${testPassword}\0${testClientSecret}`);
  database = await startTestDatabase();
  process.env.DATABASE_URL = database.connectionString;
  tokenRoute = await import('../src/app/oauth/token/route');
  mcpRoute = await import('../src/app/mcp/route');
});

beforeEach(async () => {
  await database.db.execute('truncate table oauth_authorization_codes, oauth_access_tokens, oauth_refresh_tokens');
});

after(async () => {
  const processDatabase = globalThis as typeof globalThis & {
    journalPool?: { end: () => Promise<void> };
  };
  await processDatabase.journalPool?.end();
  await database?.close();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    const name = {
      databaseUrl: 'DATABASE_URL',
      publicOrigin: 'JOURNAL_PUBLIC_ORIGIN',
      clientSecret: 'JOURNAL_OAUTH_CLIENT_SECRET',
      webPassword: 'JOURNAL_WEB_PASSWORD',
      mcpToken: 'JOURNAL_MCP_TOKEN',
      apiToken: 'JOURNAL_API_TOKEN',
    }[key] as string;
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('OAuth metadata advertises the exact issuer, callback-capable flow, and protected MCP resource', async () => {
  const authorization = await import('../src/app/.well-known/oauth-authorization-server/route');
  const protectedRoot = await import('../src/app/.well-known/oauth-protected-resource/route');
  const protectedMcp = await import('../src/app/.well-known/oauth-protected-resource/mcp/route');

  const authorizationResponse = authorization.GET();
  const authorizationMetadata = await authorizationResponse.json();
  assert.equal(authorizationMetadata.issuer, testOrigin);
  assert.equal(authorizationMetadata.authorization_endpoint, `${testOrigin}/oauth/authorize`);
  assert.equal(authorizationMetadata.token_endpoint, `${testOrigin}/oauth/token`);
  assert.deepEqual(authorizationMetadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(authorizationMetadata.token_endpoint_auth_methods_supported, ['client_secret_basic', 'client_secret_post']);
  assert.equal(authorizationMetadata.authorization_response_iss_parameter_supported, true);

  for (const response of [protectedRoot.GET(), protectedMcp.GET()]) {
    const metadata = await response.json();
    assert.equal(metadata.resource, testResource);
    assert.deepEqual(metadata.authorization_servers, [testOrigin]);
    assert.deepEqual(metadata.scopes_supported, ['journal']);
  }
});

test('authorization-code exchange accepts confidential clients and enforces one-time codes', async () => {
  const issued = await issueCode();
  const first = await exchange(issued.code);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const tokens = await first.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.scope, 'journal offline_access');
  assert.equal(tokens.expires_in, 3600);
  assert.match(tokens.access_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.refresh_token, /^[A-Za-z0-9_-]{43}$/);

  const replay = await exchange(issued.code);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
});

test('token endpoint accepts Basic authentication and rotates refresh tokens once', async () => {
  const issued = await issueCode();
  const first = await exchange(issued.code, { authorization: basicHeader() });
  assert.equal(first.status, 200);
  const tokens = await first.json();

  const next = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    resource: testResource,
  }, { authorization: basicHeader() });
  assert.equal(next.status, 200);
  const rotated = await next.json();
  assert.notEqual(rotated.access_token, tokens.access_token);
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);

  const replay = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    resource: testResource,
  }, { authorization: basicHeader() });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, 'invalid_grant');
});

test('token endpoint rejects wrong credentials, client IDs, resources, grants, and browser origins', async () => {
  const wrongClient = await tokenRequest({
    grant_type: 'refresh_token', refresh_token: 'unused', resource: testResource,
    client_id: 'other-client', client_secret: testClientSecret,
  });
  assert.equal(wrongClient.status, 401);
  assert.equal((await wrongClient.json()).error, 'invalid_client');

  const wrongSecret = await tokenRequest({
    grant_type: 'refresh_token', refresh_token: 'unused', resource: testResource,
    client_id: oauthClientId, client_secret: 'incorrect-client-secret-value',
  });
  assert.equal(wrongSecret.status, 401);

  const sameBasicId = await exchange((await issueCode()).code, {
    authorization: basicHeader(),
  });
  assert.equal(sameBasicId.status, 200);

  const conflictingBodyId = await tokenRequest({
    grant_type: 'refresh_token', refresh_token: 'unused', resource: testResource,
    client_id: 'other-client',
  }, { authorization: basicHeader() });
  assert.equal(conflictingBodyId.status, 401);

  const wrongResource = await tokenRequest({
    grant_type: 'refresh_token', refresh_token: 'unused', resource: `${testOrigin}/other`,
    client_id: oauthClientId, client_secret: testClientSecret,
  });
  assert.equal(wrongResource.status, 400);
  assert.equal((await wrongResource.json()).error, 'invalid_target');

  const unsupported = await tokenRequest({
    grant_type: 'client_credentials', resource: testResource,
    client_id: oauthClientId, client_secret: testClientSecret,
  });
  assert.equal((await unsupported.json()).error, 'unsupported_grant_type');

  const crossOrigin = await tokenRequest({ grant_type: 'authorization_code' }, { origin: 'https://attacker.example' });
  assert.equal(crossOrigin.status, 400);
  assert.equal((await crossOrigin.json()).error, 'invalid_request');
});

test('MCP endpoint advertises OAuth discovery and accepts only valid audience-bound OAuth access tokens', async () => {
  const missing = await mcpRoute.POST(new Request(`${testOrigin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }));
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate') ?? '', /oauth-protected-resource\/mcp/);

  const issued = await issueCode('journal');
  const tokenResponse = await exchange(issued.code);
  const { access_token: accessToken } = await tokenResponse.json();
  const authorized = await mcpRoute.POST(new Request(`${testOrigin}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oauth-test', version: '1' } },
    }),
  }));
  assert.equal(authorized.status, 200);
  const responseBody = await authorized.text();
  const result = authorized.headers.get('content-type')?.startsWith('text/event-stream')
    ? JSON.parse(responseBody.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim() ?? '{}')
    : JSON.parse(responseBody);
  assert.equal(result.result?.protocolVersion, '2025-11-25');
});
