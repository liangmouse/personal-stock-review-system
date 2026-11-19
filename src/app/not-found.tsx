import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page-state">
      <span aria-hidden="true" className="state-mark">?</span>
      <h1>没有找到这笔订单</h1>
      <p>订单编号无效，或记录已不存在。</p>
      <Link className="button button-primary" href="/">返回总览</Link>
    </main>
  );
}
