'use server';

import { createAuthorizationCode } from '@/lib/oauth-store';
import { getDb } from '@/db/client';
import { countJournalAttempt, RateLimitError } from '@/lib/rate-limit';
import {
  oauthCallbackUrl,
  oauthAuthorizationVersion,
  isOAuthConfigurationReady,
  parseOAuthAuthorizationRequest,
} from '@/lib/oauth-http';
import {
  clearSessionCookie,
  isSameOriginAction,
  sessionCookieName,
} from '@/lib/session';
import {
  createSessionToken,
  hasValidWebPassword,
  passwordsMatch,
  sessionCookieOptions,
  verifySessionToken,
} from '@/lib/session-token';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export type AuthorizationState = { error: string | null };

function formParameters(formData: FormData) {
  const params = new URLSearchParams();
  for (const name of [
    'client_id', 'redirect_uri', 'response_type', 'scope', 'resource',
    'code_challenge', 'code_challenge_method', 'state',
  ]) {
    const values = formData.getAll(name);
    if (values.length > 1 || (values.length === 1 && typeof values[0] !== 'string')) return null;
    if (typeof values[0] === 'string') params.set(name, values[0]);
  }
  return params;
}

export async function authorizeAction(
  _previousState: AuthorizationState,
  formData: FormData,
): Promise<AuthorizationState> {
  if (!await isSameOriginAction()) return { error: '请求来源无法验证，请重新打开连接页面。' };

  const params = formParameters(formData);
  const parsed = params && parseOAuthAuthorizationRequest(params);
  if (!parsed?.ok) return { error: '连接请求已失效，请重新开始授权。' };
  const request = parsed.request;
  const decision = formData.get('decision');
  if (decision === 'deny') redirect(oauthCallbackUrl(request, { error: 'access_denied' }));
  if (decision !== 'approve') return { error: '请选择是否允许连接。' };

  const password = process.env.JOURNAL_WEB_PASSWORD;
  const version = oauthAuthorizationVersion();
  if (!hasValidWebPassword(password) || !version || !isOAuthConfigurationReady()) {
    return { error: '授权暂不可用，请检查服务端配置。' };
  }

  const cookieStore = await cookies();
  const existingSession = cookieStore.get(sessionCookieName())?.value;
  const signedIn = verifySessionToken(existingSession, password);
  if (!signedIn) {
    try {
      await countJournalAttempt(2, 5, '尝试次数过多，请一分钟后重试。');
    } catch (error) {
      if (error instanceof RateLimitError) return { error: error.message };
      return { error: '授权暂不可用，请稍后重试。' };
    }
    const attemptedPassword = formData.get('password');
    if (
      typeof attemptedPassword !== 'string' || attemptedPassword.length > 512 ||
      !passwordsMatch(attemptedPassword, password)
    ) return { error: '访问密码不正确。' };
    cookieStore.set(sessionCookieName(), createSessionToken(password), sessionCookieOptions(process.env.NODE_ENV === 'production'));
  }

  let authorizationCode: string;
  try {
    const authorization = await createAuthorizationCode(getDb(), {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope: request.scope,
      resource: request.resource,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      authorizationVersion: version,
    });
    authorizationCode = authorization.code;
  } catch {
    if (!signedIn) await clearSessionCookie();
    return { error: '授权服务暂不可用，请稍后重试。' };
  }
  redirect(oauthCallbackUrl(request, { code: authorizationCode }));
}
