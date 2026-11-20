import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import * as schema from "@/db/schema";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const oauthClientId = "journal-chatgpt";
export const chatGptRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
export const oauthAccessTokenLifetimeSeconds = 60 * 60;
export const oauthAuthorizationCodeLifetimeSeconds = 5 * 60;
export const oauthRefreshTokenLifetimeSeconds = 30 * 24 * 60 * 60;

const challengePattern = /^[A-Za-z0-9_-]{43}$/;
const verifierPattern = /^[A-Za-z0-9._~-]{43,128}$/;
const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export class OAuthStoreError extends Error {
  constructor(readonly code: "invalid_request" | "invalid_grant") {
    super(code);
    this.name = "OAuthStoreError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function tokenHash(value: string) {
  return sha256(value);
}

function randomToken() {
  return randomBytes(32).toString("base64url");
}

function secretEquals(supplied: string, expected: string) {
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function canonicalScope(scope: string) {
  const values = scope.split(/\s+/).filter(Boolean);
  const distinct = new Set(values);
  if (
    values.length === 0 ||
    distinct.size !== values.length ||
    !distinct.has("journal") ||
    [...distinct].some((value) => value !== "journal" && value !== "offline_access")
  ) {
    throw new OAuthStoreError("invalid_request");
  }
  return distinct.has("offline_access") ? "journal offline_access" : "journal";
}

function requireResource(resource: string) {
  if (resource !== oauthResource()) throw new OAuthStoreError("invalid_request");
}

function oauthIssuer() {
  const configured = process.env.JOURNAL_PUBLIC_ORIGIN;
  if (!configured) throw new Error("OAuth public origin is not configured.");
  const url = new URL(configured);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) throw new Error("OAuth public origin must be an HTTPS origin.");
  return url.origin;
}

export function oauthAuthorizationServerIssuer() {
  return oauthIssuer();
}

export function oauthResource() {
  return `${oauthIssuer()}/mcp`;
}

export function authorizationVersion(webPassword: string) {
  return sha256(`personal-stock-review-system/oauth-authorization/v1\0${webPassword}`);
}

export function verifyOAuthClientSecret(supplied: string | undefined, expected: string | undefined) {
  if (
    supplied === undefined ||
    expected === undefined ||
    !/^[!-~]{32,}$/.test(expected)
  ) return false;
  return secretEquals(supplied, expected);
}

export type CreateAuthorizationCode = {
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  authorizationVersion: string;
};

export async function createAuthorizationCode(
  db: Database,
  input: CreateAuthorizationCode,
  now = new Date(),
) {
  if (
    input.clientId !== oauthClientId ||
    input.redirectUri !== chatGptRedirectUri ||
    input.codeChallengeMethod !== "S256" ||
    !challengePattern.test(input.codeChallenge) ||
    !hashPattern.test(input.authorizationVersion)
  ) throw new OAuthStoreError("invalid_request");
  const scope = canonicalScope(input.scope);
  requireResource(input.resource);

  const code = randomToken();
  const expiresAt = new Date(now.getTime() + oauthAuthorizationCodeLifetimeSeconds * 1000);
  await db.insert(schema.oauthAuthorizationCodes).values({
    codeHash: tokenHash(code),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    scope,
    resource: input.resource,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    authorizationVersion: input.authorizationVersion,
    expiresAt,
    createdAt: now,
  });
  return { code, expiresAt };
}

type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  scope: string;
  resource: string;
  expiresIn: number;
  refreshExpiresAt?: Date;
};

function createAccessToken(
  tx: Transaction,
  input: {
    familyId: string | null;
    clientId: string;
    scope: string;
    resource: string;
    authorizationVersion: string;
    now: Date;
  },
) {
  const accessToken = randomToken();
  return tx.insert(schema.oauthAccessTokens).values({
    tokenHash: tokenHash(accessToken),
    familyId: input.familyId,
    clientId: input.clientId,
    scope: input.scope,
    resource: input.resource,
    authorizationVersion: input.authorizationVersion,
    expiresAt: new Date(input.now.getTime() + oauthAccessTokenLifetimeSeconds * 1000),
    createdAt: input.now,
  }).then(() => accessToken);
}

function createRefreshToken(
  tx: Transaction,
  input: {
    familyId: string;
    clientId: string;
    scope: string;
    resource: string;
    authorizationVersion: string;
    familyExpiresAt: Date;
    now: Date;
  },
) {
  const refreshToken = randomToken();
  return tx.insert(schema.oauthRefreshTokens).values({
    tokenHash: tokenHash(refreshToken),
    familyId: input.familyId,
    clientId: input.clientId,
    scope: input.scope,
    resource: input.resource,
    authorizationVersion: input.authorizationVersion,
    familyExpiresAt: input.familyExpiresAt,
    createdAt: input.now,
  }).then(() => refreshToken);
}

export type ExchangeAuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
  authorizationVersion: string;
};

export async function exchangeAuthorizationCode(
  db: Database,
  input: ExchangeAuthorizationCode,
  now = new Date(),
): Promise<OAuthTokenSet> {
  if (
    input.clientId !== oauthClientId ||
    input.redirectUri !== chatGptRedirectUri ||
    !opaqueTokenPattern.test(input.code) ||
    !verifierPattern.test(input.codeVerifier) ||
    !hashPattern.test(input.authorizationVersion)
  ) throw new OAuthStoreError("invalid_grant");
  requireResource(input.resource);
  const verifierChallenge = createHash("sha256")
    .update(input.codeVerifier)
    .digest("base64url");

  return db.transaction(async (tx) => {
    const [record] = await tx.select()
      .from(schema.oauthAuthorizationCodes)
      .where(eq(schema.oauthAuthorizationCodes.codeHash, tokenHash(input.code)))
      .for("update");
    if (
      !record ||
      record.consumedAt ||
      record.expiresAt <= now ||
      record.clientId !== input.clientId ||
      record.redirectUri !== input.redirectUri ||
      record.resource !== input.resource ||
      record.authorizationVersion !== input.authorizationVersion ||
      !secretEquals(record.codeChallenge, verifierChallenge)
    ) throw new OAuthStoreError("invalid_grant");

    await tx.update(schema.oauthAuthorizationCodes)
      .set({ consumedAt: now })
      .where(and(
        eq(schema.oauthAuthorizationCodes.codeHash, record.codeHash),
        isNull(schema.oauthAuthorizationCodes.consumedAt),
        gt(schema.oauthAuthorizationCodes.expiresAt, now),
      ));

    const hasRefresh = record.scope === "journal offline_access";
    if (!hasRefresh) {
      const accessToken = await createAccessToken(tx, {
        familyId: null,
        clientId: record.clientId,
        scope: record.scope,
        resource: record.resource,
        authorizationVersion: record.authorizationVersion,
        now,
      });
      return {
        accessToken,
        scope: record.scope,
        resource: record.resource,
        expiresIn: oauthAccessTokenLifetimeSeconds,
      };
    }

    const familyId = randomUUID();
    const accessToken = await createAccessToken(tx, {
      familyId,
      clientId: record.clientId,
      scope: record.scope,
      resource: record.resource,
      authorizationVersion: record.authorizationVersion,
      now,
    });
    const refreshExpiresAt = new Date(now.getTime() + oauthRefreshTokenLifetimeSeconds * 1000);
    const refreshToken = await createRefreshToken(tx, {
      familyId,
      clientId: record.clientId,
      scope: record.scope,
      resource: record.resource,
      authorizationVersion: record.authorizationVersion,
      familyExpiresAt: refreshExpiresAt,
      now,
    });
    return {
      accessToken,
      refreshToken,
      scope: record.scope,
      resource: record.resource,
      expiresIn: oauthAccessTokenLifetimeSeconds,
      refreshExpiresAt,
    };
  });
}

export type RotateRefreshToken = {
  refreshToken: string;
  clientId: string;
  resource: string;
  authorizationVersion: string;
};

export async function rotateRefreshToken(
  db: Database,
  input: RotateRefreshToken,
  now = new Date(),
): Promise<OAuthTokenSet | null> {
  if (
    input.clientId !== oauthClientId ||
    !opaqueTokenPattern.test(input.refreshToken) ||
    !hashPattern.test(input.authorizationVersion)
  ) return null;
  try {
    requireResource(input.resource);
  } catch {
    return null;
  }

  return db.transaction(async (tx) => {
    const [candidate] = await tx.select({ familyId: schema.oauthRefreshTokens.familyId })
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.tokenHash, tokenHash(input.refreshToken)))
      .limit(1);
    if (!candidate) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${candidate.familyId}::text, 0))`);

    const [record] = await tx.select()
      .from(schema.oauthRefreshTokens)
      .where(eq(schema.oauthRefreshTokens.tokenHash, tokenHash(input.refreshToken)))
      .for("update");
    if (
      !record ||
      record.clientId !== input.clientId ||
      record.resource !== input.resource ||
      record.authorizationVersion !== input.authorizationVersion ||
      record.revokedAt ||
      record.familyExpiresAt <= now
    ) return null;

    if (record.consumedAt) {
      await tx.update(schema.oauthRefreshTokens)
        .set({ revokedAt: now })
        .where(and(
          eq(schema.oauthRefreshTokens.familyId, record.familyId),
          isNull(schema.oauthRefreshTokens.revokedAt),
        ));
      await tx.update(schema.oauthAccessTokens)
        .set({ revokedAt: now })
        .where(and(
          eq(schema.oauthAccessTokens.familyId, record.familyId),
          isNull(schema.oauthAccessTokens.revokedAt),
        ));
      return null;
    }

    await tx.update(schema.oauthRefreshTokens)
      .set({ consumedAt: now })
      .where(and(
        eq(schema.oauthRefreshTokens.tokenHash, record.tokenHash),
        isNull(schema.oauthRefreshTokens.consumedAt),
        isNull(schema.oauthRefreshTokens.revokedAt),
        gt(schema.oauthRefreshTokens.familyExpiresAt, now),
      ));

    const accessToken = await createAccessToken(tx, {
      familyId: record.familyId,
      clientId: record.clientId,
      scope: record.scope,
      resource: record.resource,
      authorizationVersion: record.authorizationVersion,
      now,
    });
    const refreshToken = await createRefreshToken(tx, {
      familyId: record.familyId,
      clientId: record.clientId,
      scope: record.scope,
      resource: record.resource,
      authorizationVersion: record.authorizationVersion,
      familyExpiresAt: record.familyExpiresAt,
      now,
    });
    return {
      accessToken,
      refreshToken,
      scope: record.scope,
      resource: record.resource,
      expiresIn: oauthAccessTokenLifetimeSeconds,
      refreshExpiresAt: record.familyExpiresAt,
    };
  });
}

export async function verifyAccessToken(
  db: Database,
  token: string,
  expected: { clientId: string; resource: string; authorizationVersion: string },
  now = new Date(),
) {
  if (
    expected.clientId !== oauthClientId ||
    !opaqueTokenPattern.test(token) ||
    !hashPattern.test(expected.authorizationVersion)
  ) return null;
  try {
    requireResource(expected.resource);
  } catch {
    return null;
  }
  const [record] = await db.select({
    scope: schema.oauthAccessTokens.scope,
    resource: schema.oauthAccessTokens.resource,
    expiresAt: schema.oauthAccessTokens.expiresAt,
  })
    .from(schema.oauthAccessTokens)
    .where(and(
      eq(schema.oauthAccessTokens.tokenHash, tokenHash(token)),
      eq(schema.oauthAccessTokens.clientId, expected.clientId),
      eq(schema.oauthAccessTokens.resource, expected.resource),
      eq(schema.oauthAccessTokens.authorizationVersion, expected.authorizationVersion),
      isNull(schema.oauthAccessTokens.revokedAt),
      gt(schema.oauthAccessTokens.expiresAt, now),
    ))
    .limit(1);
  return record ?? null;
}

export async function pruneExpiredOAuthState(db: Database, now = new Date()) {
  const [codes, accessTokens, refreshTokens] = await db.transaction(async (tx) => {
    const codes = await tx.delete(schema.oauthAuthorizationCodes)
      .where(lte(schema.oauthAuthorizationCodes.expiresAt, now))
      .returning({ codeHash: schema.oauthAuthorizationCodes.codeHash });
    const accessTokens = await tx.delete(schema.oauthAccessTokens)
      .where(or(
        lte(schema.oauthAccessTokens.expiresAt, now),
        lte(schema.oauthAccessTokens.revokedAt, now),
      ))
      .returning({ tokenHash: schema.oauthAccessTokens.tokenHash });
    const refreshTokens = await tx.delete(schema.oauthRefreshTokens)
      .where(or(
        lte(schema.oauthRefreshTokens.familyExpiresAt, now),
        lte(schema.oauthRefreshTokens.revokedAt, now),
      ))
      .returning({ tokenHash: schema.oauthRefreshTokens.tokenHash });
    return [codes, accessTokens, refreshTokens] as const;
  });
  return {
    authorizationCodes: codes.length,
    accessTokens: accessTokens.length,
    refreshTokens: refreshTokens.length,
  };
}
