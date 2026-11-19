'use client';

import { useActionState } from 'react';

import { loginAction, type LoginState } from './actions';
import styles from './login.module.css';

const initialState: LoginState = { error: null };

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initialState);

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="login-title">
        <div className={styles.mark} aria-hidden="true">交</div>
        <p className={styles.kicker}>个人交易日志</p>
        <h1 id="login-title">欢迎回来</h1>
        <p className={styles.description}>输入访问密码，查看你的交易记录。</p>

        <form action={action} className={styles.form}>
          <label htmlFor="password">访问密码</label>
          <input
            autoComplete="current-password"
            autoFocus
            id="password"
            name="password"
            required
            type="password"
            maxLength={512}
          />
          {state.error && <p className={styles.error} role="alert">{state.error}</p>}
          <button disabled={pending} type="submit">
            {pending ? '正在验证…' : '继续'}
          </button>
        </form>
        <p className={styles.footnote}>仅限本人使用</p>
      </section>
    </main>
  );
}
