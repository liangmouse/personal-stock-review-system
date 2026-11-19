import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sessionDurationSeconds = 12 * 60 * 60;

const secretFormat = /^[!-~]{24,}$/;
const signatureContext = 'personal-stock-review-system/web-session/v1';

export function sessionCookieName(isProduction: boolean) {
  return isProduction ? '__Host-journal-session' : 'journal-session';
}

export function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true as const,
    secure: isProduction,
    sameSite: 'strict' as const,
    path: '/' as const,
    maxAge: sessionDurationSeconds,
  };
}

export function matchesSameOrigin(
  origin: string | null,
  host: string | null,
  forwardedProtocol: string | null,
  isProduction: boolean,
) {
  if (!origin || !host) return false;
  try {
    const parsedOrigin = new URL(origin);
    const protocol = forwardedProtocol?.split(',')[0].trim() || (isProduction ? 'https' : 'http');
    return parsedOrigin.username === '' &&
      parsedOrigin.password === '' &&
      parsedOrigin.pathname === '/' &&
      parsedOrigin.search === '' &&
      parsedOrigin.hash === '' &&
      parsedOrigin.host.toLowerCase() === host.toLowerCase() &&
      parsedOrigin.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

export function hasValidWebPassword(password: string | undefined): password is string {
  return password !== undefined && secretFormat.test(password);
}

function signingKey(password: string) {
  return createHmac('sha256', password).update(signatureContext).digest();
}

function signature(payload: string, password: string) {
  return createHmac('sha256', signingKey(password)).update(payload).digest('base64url');
}

export function passwordsMatch(attempt: string, configured: string) {
  const attemptedDigest = createHash('sha256').update(attempt).digest();
  const configuredDigest = createHash('sha256').update(configured).digest();
  return timingSafeEqual(attemptedDigest, configuredDigest);
}

export function createSessionToken(password: string, now = Date.now()) {
  if (!hasValidWebPassword(password)) throw new Error('Invalid web password configuration.');
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + sessionDurationSeconds;
  const nonce = randomBytes(16).toString('base64url');
  const payload = `v1.${issuedAt}.${expiresAt}.${nonce}`;
  return `${payload}.${signature(payload, password)}`;
}

export function verifySessionToken(
  token: string | undefined,
  password: string | undefined,
  now = Date.now(),
) {
  if (!token || !hasValidWebPassword(password)) return false;

  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return false;

  const [, issuedAtText, expiresAtText, nonce, suppliedSignature] = parts;
  if (
    !/^\d{1,12}$/.test(issuedAtText) ||
    !/^\d{1,12}$/.test(expiresAtText) ||
    !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(suppliedSignature)
  ) return false;

  const issuedAt = Number(issuedAtText);
  const expiresAt = Number(expiresAtText);
  const nowSeconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > nowSeconds + 60 ||
    expiresAt <= nowSeconds ||
    expiresAt - issuedAt !== sessionDurationSeconds
  ) return false;

  const payload = parts.slice(0, 4).join('.');
  const expectedSignature = Buffer.from(signature(payload, password));
  const actualSignature = Buffer.from(suppliedSignature);
  return timingSafeEqual(expectedSignature, actualSignature);
}
