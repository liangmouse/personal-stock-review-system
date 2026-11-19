import 'server-only';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { countJournalAttempt } from './rate-limit';
import {
  matchesSameOrigin,
  sessionCookieName as getSessionCookieName,
  sessionCookieOptions,
  verifySessionToken,
} from './session-token';

export function sessionCookieName() {
  return getSessionCookieName(process.env.NODE_ENV === 'production');
}

function cookieOptions() {
  return sessionCookieOptions(process.env.NODE_ENV === 'production');
}

export async function requireSession() {
  const configuredPassword = process.env.JOURNAL_WEB_PASSWORD;
  const cookieStore = await cookies();
  const value = cookieStore.get(sessionCookieName())?.value;
  if (!verifySessionToken(value, configuredPassword)) redirect('/login');
}

export async function countReviewAttempt() {
  await countJournalAttempt(3, 30, '保存过于频繁，请稍后重试。');
}

export function setSessionCookie(token: string) {
  return cookies().then((cookieStore) => {
    cookieStore.set(sessionCookieName(), token, cookieOptions());
  });
}

export function clearSessionCookie() {
  return cookies().then((cookieStore) => {
    cookieStore.set(sessionCookieName(), '', { ...cookieOptions(), maxAge: 0 });
  });
}

export async function isSameOriginAction() {
  const requestHeaders = await headers();
  return matchesSameOrigin(
    requestHeaders.get('origin'),
    requestHeaders.get('host'),
    requestHeaders.get('x-forwarded-proto'),
    process.env.NODE_ENV === 'production',
  );
}
