'use server';

import { redirect } from 'next/navigation';

import { countJournalAttempt, RateLimitError } from '@/lib/rate-limit';
import { clearSessionCookie, isSameOriginAction, setSessionCookie } from '@/lib/session';
import { createSessionToken, hasValidWebPassword, passwordsMatch } from '@/lib/session-token';

export type LoginState = { error: string | null };

export async function loginAction(_previousState: LoginState, formData: FormData): Promise<LoginState> {
  if (!await isSameOriginAction()) return { error: '无法验证请求来源，请刷新页面后重试。' };

  const configuredPassword = process.env.JOURNAL_WEB_PASSWORD;
  if (!hasValidWebPassword(configuredPassword)) {
    return { error: '登录暂不可用，请联系部署者检查配置。' };
  }

  try {
    await countJournalAttempt(2, 5, '尝试次数过多，请一分钟后重试。');
  } catch (error) {
    if (error instanceof RateLimitError) return { error: error.message };
    return { error: '登录暂不可用，请稍后重试。' };
  }

  const attempt = formData.get('password');
  if (typeof attempt !== 'string' || attempt.length > 512 || !passwordsMatch(attempt, configuredPassword)) {
    return { error: '密码不正确。' };
  }

  await setSessionCookie(createSessionToken(configuredPassword));
  redirect('/');
}

export async function logout() {
  if (!await isSameOriginAction()) return;
  await clearSessionCookie();
  redirect('/login');
}
