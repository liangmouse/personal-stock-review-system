import type { ReactNode } from "react";
import Link from "next/link";

import { logout } from "@/app/login/actions";
import { NavLinks } from "@/components/nav-links";

export function JournalShell({ children }: { children: ReactNode }) {
  return (
    <div className="journal-layout">
      <aside className="sidebar">
        <Link aria-label="交易日志总览" className="brand" href="/">
          <span aria-hidden="true" className="brand-mark">记</span>
          <span className="brand-copy">
            <strong>交易日志</strong>
          </span>
        </Link>
        <NavLinks />
        <div className="sidebar-bottom">
          <form action={logout}>
            <button className="logout-button" type="submit">
              <span aria-hidden="true">↗</span>
              <span>退出登录</span>
            </button>
          </form>
        </div>
      </aside>
      <div className="workspace">
        <main className="workspace-main">{children}</main>
      </div>
    </div>
  );
}
