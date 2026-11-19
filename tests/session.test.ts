import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createSessionToken,
  hasValidWebPassword,
  matchesSameOrigin,
  passwordsMatch,
  sessionCookieName,
  sessionCookieOptions,
  sessionDurationSeconds,
  verifySessionToken,
} from '../src/lib/session-token';

const password = 'synthetic-test-password-only-not-a-secret';

test('session token expires after twelve hours', () => {
  const issuedAt = Date.UTC(2026, 10, 19, 10, 0, 0);
  const token = createSessionToken(password, issuedAt);

  assert.equal(verifySessionToken(token, password, issuedAt), true);
  assert.equal(
    verifySessionToken(token, password, issuedAt + sessionDurationSeconds * 1000),
    false,
  );
});

test('modified, malformed, and password-rotated tokens are rejected', () => {
  const token = createSessionToken(password, Date.UTC(2026, 10, 19, 10, 0, 0));
  const parts = token.split('.');
  parts[1] = String(Number(parts[1]) + 1);
  const alteredSignature = token.replace(/.$/, token.endsWith('a') ? 'b' : 'a');

  assert.equal(verifySessionToken(parts.join('.'), password), false);
  assert.equal(verifySessionToken(alteredSignature, password), false);
  assert.equal(verifySessionToken(token, `${password}rotated`), false);
  assert.equal(verifySessionToken(token, undefined), false);
  assert.equal(verifySessionToken(token, 'too-short'), false);
  assert.equal(verifySessionToken(`${token}.extra`, password), false);
});

test('web passwords need at least 24 printable non-space ASCII characters', () => {
  assert.equal(hasValidWebPassword(password), true);
  assert.equal(hasValidWebPassword('a'.repeat(23)), false);
  assert.equal(hasValidWebPassword(`a${'b'.repeat(23)} `), false);
  assert.equal(hasValidWebPassword(undefined), false);
  assert.equal(passwordsMatch(password, password), true);
  assert.equal(passwordsMatch(password, `${password}rotated`), false);
});

test('session cookie flags change only for secure production transport', () => {
  assert.equal(sessionCookieName(false), 'journal-session');
  assert.equal(sessionCookieName(true), '__Host-journal-session');
  assert.deepEqual(sessionCookieOptions(false), {
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    path: '/',
    maxAge: sessionDurationSeconds,
  });
  assert.equal(sessionCookieOptions(true).secure, true);
});

test('server actions accept only the same host and forwarded protocol origin', () => {
  assert.equal(matchesSameOrigin('https://journal.example', 'journal.example', 'https', true), true);
  assert.equal(matchesSameOrigin('https://evil.example', 'journal.example', 'https', true), false);
  assert.equal(matchesSameOrigin('http://journal.example', 'journal.example', 'https', true), false);
  assert.equal(matchesSameOrigin(null, 'journal.example', 'https', true), false);
});
