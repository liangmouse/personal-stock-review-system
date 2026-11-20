import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { eq } from "drizzle-orm";

import * as schema from "../src/db/schema";
import {
  authorizationVersion,
  chatGptRedirectUri,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  oauthAccessTokenLifetimeSeconds,
  oauthAuthorizationCodeLifetimeSeconds,
  oauthClientId,
  oauthRefreshTokenLifetimeSeconds,
  oauthResource,
  OAuthStoreError,
  pruneExpiredOAuthState,
  rotateRefreshToken,
  verifyAccessToken,
  verifyOAuthClientSecret,
} from "../src/lib/oauth-store";
import { startTestDatabase } from "./helper";

const originalOrigin = process.env.JOURNAL_PUBLIC_ORIGIN;
let database: Awaited<ReturnType<typeof startTestDatabase>>;
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const oldPassword = "an-independent-random-web-password-for-tests";
const newPassword = "a-rotated-independent-web-password-for-tests";
const oldAuthorizationVersion = authorizationVersion(oldPassword);
const resource = "https://journal.example/mcp";
const baseTime = new Date("2026-11-20T00:00:00.000Z");

before(async () => {
  process.env.JOURNAL_PUBLIC_ORIGIN = "https://journal.example";
  database = await startTestDatabase();
});

beforeEach(async () => {
  await database.db.execute("truncate table oauth_authorization_codes, oauth_access_tokens, oauth_refresh_tokens");
});

after(async () => {
  await database?.close();
  if (originalOrigin === undefined) delete process.env.JOURNAL_PUBLIC_ORIGIN;
  else process.env.JOURNAL_PUBLIC_ORIGIN = originalOrigin;
});

async function issueCode(
  scope = "journal offline_access",
  now = baseTime,
  overrides: Partial<Parameters<typeof createAuthorizationCode>[1]> = {},
) {
  return createAuthorizationCode(database.db, {
    clientId: oauthClientId,
    redirectUri: chatGptRedirectUri,
    scope,
    resource: oauthResource(),
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    authorizationVersion: oldAuthorizationVersion,
    ...overrides,
  }, now);
}

function exchange(code: string, now = baseTime, overrides: Record<string, unknown> = {}) {
  return exchangeAuthorizationCode(database.db, {
    code,
    clientId: oauthClientId,
    redirectUri: chatGptRedirectUri,
    codeVerifier: verifier,
    resource,
    authorizationVersion: oldAuthorizationVersion,
    ...overrides,
  } as Parameters<typeof exchangeAuthorizationCode>[1], now);
}

test("OAuth configuration is bound to one confidential client, redirect, HTTPS issuer, and resource", async () => {
  assert.equal(oauthClientId, "journal-chatgpt");
  assert.equal(chatGptRedirectUri, "https://chatgpt.com/connector_platform_oauth_redirect");
  assert.equal(oauthResource(), resource);
  assert.equal(authorizationVersion(oldPassword), authorizationVersion(oldPassword));
  assert.notEqual(authorizationVersion(oldPassword), authorizationVersion(newPassword));
  assert.equal(verifyOAuthClientSecret("x".repeat(32), "x".repeat(32)), true);
  assert.equal(verifyOAuthClientSecret("y".repeat(32), "x".repeat(32)), false);
  assert.equal(verifyOAuthClientSecret("x".repeat(31), "x".repeat(31)), false);
  assert.equal(verifyOAuthClientSecret(undefined, "x".repeat(32)), false);

  await assert.rejects(
    issueCode("journal", baseTime, { redirectUri: "https://attacker.example/callback" }),
    (error: unknown) => error instanceof OAuthStoreError && error.code === "invalid_request",
  );
  await assert.rejects(
    issueCode("profile", baseTime),
    (error: unknown) => error instanceof OAuthStoreError && error.code === "invalid_request",
  );
  await assert.rejects(
    issueCode("journal journal", baseTime),
    (error: unknown) => error instanceof OAuthStoreError && error.code === "invalid_request",
  );
  await assert.rejects(
    issueCode("journal", baseTime, { codeChallengeMethod: "plain" as "S256" }),
    (error: unknown) => error instanceof OAuthStoreError && error.code === "invalid_request",
  );
});

test("authorization code stores only its hash, validates S256, expires, and exchanges once", async () => {
  const { code, expiresAt } = await issueCode();
  assert.equal(expiresAt.getTime(), baseTime.getTime() + oauthAuthorizationCodeLifetimeSeconds * 1000);

  const [storedCode] = await database.db.select().from(schema.oauthAuthorizationCodes)
    .where(eq(schema.oauthAuthorizationCodes.codeHash, createHash("sha256").update(code).digest("hex")));
  assert.ok(storedCode);
  assert.notEqual(storedCode.codeHash, code);
  assert.equal(storedCode.scope, "journal offline_access");
  assert.equal(storedCode.codeChallengeMethod, "S256");

  await assert.rejects(
    exchange(code, baseTime, { codeVerifier: randomBytes(32).toString("base64url") }),
    (error: unknown) => error instanceof OAuthStoreError && error.code === "invalid_grant",
  );
  const [unconsumed] = await database.db.select().from(schema.oauthAuthorizationCodes)
    .where(eq(schema.oauthAuthorizationCodes.codeHash, storedCode.codeHash));
  assert.equal(unconsumed.consumedAt, null);

  const results = await Promise.allSettled([
    exchange(code),
    exchange(code),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const tokens = results.find((result) => result.status === "fulfilled");
  assert.ok(tokens && tokens.status === "fulfilled");
  assert.equal(tokens.value.scope, "journal offline_access");
  assert.equal(tokens.value.resource, resource);
  assert.equal(tokens.value.expiresIn, oauthAccessTokenLifetimeSeconds);
  assert.ok(tokens.value.refreshToken);
  assert.equal(tokens.value.refreshExpiresAt?.getTime(), baseTime.getTime() + oauthRefreshTokenLifetimeSeconds * 1000);

  const accessRows = await database.db.select().from(schema.oauthAccessTokens);
  assert.equal(accessRows.length, 1);
  assert.notEqual(accessRows[0]?.tokenHash, tokens.value.accessToken);
  assert.equal(await verifyAccessToken(database.db, tokens.value.accessToken, {
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(baseTime.getTime() + oauthAccessTokenLifetimeSeconds * 1000)), null);

  const access = await verifyAccessToken(database.db, tokens.value.accessToken, {
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(baseTime.getTime() + 1));
  assert.ok(access);
  assert.equal(access.scope, "journal offline_access");
  assert.equal(await verifyAccessToken(database.db, tokens.value.accessToken, {
    clientId: "another-client",
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(baseTime.getTime() + 1)), null);
  assert.equal(await verifyAccessToken(database.db, tokens.value.accessToken, {
    clientId: oauthClientId,
    resource: "https://other.example/mcp",
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(baseTime.getTime() + 1)), null);
  assert.equal(await verifyAccessToken(database.db, tokens.value.accessToken, {
    clientId: oauthClientId,
    resource,
    authorizationVersion: authorizationVersion(newPassword),
  }, new Date(baseTime.getTime() + 1)), null);

  const expiredCode = await issueCode("journal", baseTime);
  await assert.rejects(
    exchange(expiredCode.code, new Date(expiredCode.expiresAt.getTime() + 1)),
    (error: unknown) => error instanceof OAuthStoreError && error.code === "invalid_grant",
  );
  const noRefresh = await issueCode("journal", new Date(baseTime.getTime() + 1));
  const accessOnly = await exchange(noRefresh.code, new Date(baseTime.getTime() + 1));
  assert.equal(accessOnly.refreshToken, undefined);
});

test("refresh rotation preserves the absolute lifetime and replay revokes every token in the family", async () => {
  const { code } = await issueCode();
  const initial = await exchange(code);
  assert.ok(initial.refreshToken);

  const nextTime = new Date(baseTime.getTime() + 10_000);
  const rotated = await rotateRefreshToken(database.db, {
    refreshToken: initial.refreshToken,
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, nextTime);
  assert.ok(rotated?.refreshToken);
  assert.equal(rotated.refreshExpiresAt?.getTime(), initial.refreshExpiresAt?.getTime());

  const [initialAccess] = await database.db.select().from(schema.oauthAccessTokens)
    .where(eq(schema.oauthAccessTokens.tokenHash, createHash("sha256").update(initial.accessToken).digest("hex")));
  assert.ok(initialAccess);
  assert.equal(initialAccess.revokedAt, null);

  assert.equal(await rotateRefreshToken(database.db, {
    refreshToken: initial.refreshToken,
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(nextTime.getTime() + 1)), null);

  const [allRefresh, allAccess] = await Promise.all([
    database.db.select().from(schema.oauthRefreshTokens),
    database.db.select().from(schema.oauthAccessTokens),
  ]);
  assert.equal(allRefresh.length, 2);
  assert.ok(allRefresh.every((token) => token.revokedAt !== null));
  assert.ok(allAccess.every((token) => token.revokedAt !== null));
  assert.equal(await verifyAccessToken(database.db, rotated.accessToken, {
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(nextTime.getTime() + 2)), null);
  assert.equal(await rotateRefreshToken(database.db, {
    refreshToken: rotated.refreshToken,
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(nextTime.getTime() + 2)), null);
});

test("refresh rejects client, resource, password rotation, and expiry without issuing tokens", async () => {
  const { code } = await issueCode();
  const issued = await exchange(code);
  assert.ok(issued.refreshToken);

  assert.equal(await rotateRefreshToken(database.db, {
    refreshToken: issued.refreshToken,
    clientId: "other-client",
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(baseTime.getTime() + 1)), null);
  assert.equal(await rotateRefreshToken(database.db, {
    refreshToken: issued.refreshToken,
    clientId: oauthClientId,
    resource: "https://another.example/mcp",
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(baseTime.getTime() + 1)), null);
  assert.equal(await rotateRefreshToken(database.db, {
    refreshToken: issued.refreshToken,
    clientId: oauthClientId,
    resource,
    authorizationVersion: authorizationVersion(newPassword),
  }, new Date(baseTime.getTime() + 1)), null);

  const expiredAt = new Date(baseTime.getTime() + oauthRefreshTokenLifetimeSeconds * 1000 + 1);
  assert.equal(await rotateRefreshToken(database.db, {
    refreshToken: issued.refreshToken,
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, expiredAt), null);
});

test("refresh replay and a concurrent rotation from another generation serialize on the token family", async () => {
  const { code } = await issueCode();
  const initial = await exchange(code);
  assert.ok(initial.refreshToken);
  const rotated = await rotateRefreshToken(database.db, {
    refreshToken: initial.refreshToken,
    clientId: oauthClientId,
    resource,
    authorizationVersion: oldAuthorizationVersion,
  }, new Date(baseTime.getTime() + 1));
  assert.ok(rotated?.refreshToken);

  const [replay, concurrentRotation] = await Promise.all([
    rotateRefreshToken(database.db, {
      refreshToken: initial.refreshToken,
      clientId: oauthClientId,
      resource,
      authorizationVersion: oldAuthorizationVersion,
    }, new Date(baseTime.getTime() + 2)),
    rotateRefreshToken(database.db, {
      refreshToken: rotated.refreshToken,
      clientId: oauthClientId,
      resource,
      authorizationVersion: oldAuthorizationVersion,
    }, new Date(baseTime.getTime() + 2)),
  ]);
  assert.equal(replay, null);

  const refreshRows = await database.db.select().from(schema.oauthRefreshTokens);
  const accessRows = await database.db.select().from(schema.oauthAccessTokens);
  assert.ok(refreshRows.length >= 2);
  assert.ok(refreshRows.every((token) => token.revokedAt !== null));
  assert.ok(accessRows.every((token) => token.revokedAt !== null));
  if (concurrentRotation) {
    assert.equal(await verifyAccessToken(database.db, concurrentRotation.accessToken, {
      clientId: oauthClientId,
      resource,
      authorizationVersion: oldAuthorizationVersion,
    }, new Date(baseTime.getTime() + 3)), null);
    const newest = refreshRows.find((token) => token.tokenHash === createHash("sha256")
      .update(concurrentRotation.refreshToken!)
      .digest("hex"));
    assert.ok(newest?.revokedAt);
  }
});

test("expired OAuth records are pruned while live refresh families remain", async () => {
  const { code: expiredCode } = await issueCode("journal", baseTime);
  await exchange(expiredCode);
  const live = await issueCode("journal offline_access", new Date(baseTime.getTime() + 1000));
  await exchange(live.code, new Date(baseTime.getTime() + 1000));

  const removed = await pruneExpiredOAuthState(
    database.db,
    new Date(baseTime.getTime() + oauthRefreshTokenLifetimeSeconds * 1000 + 2000),
  );
  assert.ok(removed.authorizationCodes >= 1);
  assert.ok(removed.accessTokens >= 1);
  assert.ok(removed.refreshTokens >= 1);

  const [codes, access, refresh] = await Promise.all([
    database.db.select().from(schema.oauthAuthorizationCodes),
    database.db.select().from(schema.oauthAccessTokens),
    database.db.select().from(schema.oauthRefreshTokens),
  ]);
  assert.equal(codes.length, 0);
  assert.equal(access.length, 0);
  assert.equal(refresh.length, 0);
});
