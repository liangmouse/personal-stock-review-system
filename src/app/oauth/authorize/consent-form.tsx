'use client';

import { useActionState } from 'react';

import { authorizeAction, type AuthorizationState } from './actions';
import type { OAuthAuthorizationRequest } from '@/lib/oauth-http';
import styles from './page.module.css';

const initialState: AuthorizationState = { error: null };

export function ConsentForm({
  request,
  isSignedIn,
}: {
  request: OAuthAuthorizationRequest;
  isSignedIn: boolean;
}) {
  const [state, action, pending] = useActionState(authorizeAction, initialState);

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="client_id" value={request.clientId} />
      <input type="hidden" name="redirect_uri" value={request.redirectUri} />
      <input type="hidden" name="response_type" value="code" />
      <input type="hidden" name="scope" value={request.scope} />
      <input type="hidden" name="resource" value={request.resource} />
      <input type="hidden" name="code_challenge" value={request.codeChallenge} />
      <input type="hidden" name="code_challenge_method" value={request.codeChallengeMethod} />
      {request.state !== undefined && <input type="hidden" name="state" value={request.state} />}
      {!isSignedIn && (
        <>
          <label htmlFor="password">访问密码</label>
          <input
            autoComplete="current-password"
            autoFocus
            id="password"
            maxLength={512}
            name="password"
            required
            type="password"
          />
        </>
      )}
      {isSignedIn && <p className={styles.signedIn}>已验证你的登录状态</p>}
      {state.error && <p className={styles.error} role="alert">{state.error}</p>}
      <div className={styles.actions}>
        <button className={styles.deny} disabled={pending} name="decision" type="submit" value="deny" formNoValidate>
          拒绝
        </button>
        <button className={styles.allow} disabled={pending} name="decision" type="submit" value="approve">
          {pending ? '正在授权…' : '允许连接'}
        </button>
      </div>
      <p className={styles.footnote}>仅向你登录的 ChatGPT 连接授权。随时可以撤销该连接。</p>
    </form>
  );
}
