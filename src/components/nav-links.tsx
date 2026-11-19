"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/", label: "总览", icon: "▦" },
  { href: "/events", label: "交易流水", icon: "↕" },
  { href: "/reviews", label: "交易复盘", icon: "▤" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="主导航" className="side-nav">
      {navigation.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href ||
              (item.href === "/events" && pathname.startsWith("/orders/"));
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={active ? "side-nav-link is-active" : "side-nav-link"}
            href={item.href}
            key={item.href}
          >
            <span aria-hidden="true" className="side-nav-icon">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
