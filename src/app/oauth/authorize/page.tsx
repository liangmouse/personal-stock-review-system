import { cookies, headers } from 'next/headers';

import { sessionCookieName } from '@/lib/session';
import { oauthIssuer, parseOAuthAuthorizationRequest, requestUsesOAuthIssuer } from '@/lib/oauth-http';
import { verifySessionToken } from '@/lib/session-token';
import { ConsentForm } from './consent-form';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';

function searchParamsToUrlSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
) {
  const params = new URLSearchParams();
  for (const [name, rawValue] of Object.entries(searchParams)) {
    if (Array.isArray(rawValue)) {
      for (const value of rawValue) params.append(name, value);
    } else if (rawValue !== undefined) {
      params.append(name, rawValue);
    }
  }
  return params;
}

export default async function OAuthAuthorizationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParamsToUrlSearchParams(await searchParams);
  const result = parseOAuthAuthorizationRequest(params);
  const requestHeaders = await headers();
  if (
    !result.ok || !oauthIssuer() ||
    !requestUsesOAuthIssuer(requestHeaders.get('host'), requestHeaders.get('x-forwarded-proto'))
  ) {
    return (
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="consent-title">
          <div className={styles.mark} aria-hidden="true">交</div>
          <p className={styles.kicker}>个人交易日志</p>
          <h1 id="consent-title">无法验证连接请求</h1>
          <p className={styles.description}>请从 ChatGPT 的连接设置重新开始。</p>
        </section>
      </main>
    );
  }

  const cookieStore = await cookies();
  const password = process.env.JOURNAL_WEB_PASSWORD;
  const isSignedIn = verifySessionToken(
    cookieStore.get(sessionCookieName())?.value,
    password,
  );

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="consent-title">
        <div className={styles.mark} aria-hidden="true">交</div>
        <p className={styles.kicker}>个人交易日志</p>
        <h1 id="consent-title">允许 ChatGPT 连接？</h1>
        <p className={styles.description}>
          授权后，ChatGPT 可以读取订单与复盘，也可以按你的确认记录订单、成交、撤单和复盘。
        </p>
        <div className={styles.permission}>
          <span aria-hidden="true">✓</span>
          <span>读取并更新个人交易记录</span>
        </div>
        <ConsentForm request={result.request} isSignedIn={isSignedIn} />
      </section>
    </main>
  );
}
