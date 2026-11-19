"use client";

export default function JournalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section aria-labelledby="error-title" className="page-state page-state-error">
      <span aria-hidden="true" className="state-mark">!</span>
      <h1 id="error-title">暂时无法读取交易记录</h1>
      <p>连接数据库时遇到问题。可以重新加载本页。</p>
      <button className="retry-button" onClick={() => reset()} type="button">
        重新加载
      </button>
    </section>
  );
}
