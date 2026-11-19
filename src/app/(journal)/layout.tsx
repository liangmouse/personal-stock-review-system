import type { ReactNode } from "react";

import { JournalShell } from "@/components/journal-shell";
import { requireSession } from "@/lib/session";

export default async function JournalLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  await requireSession();
  return <JournalShell>{children}</JournalShell>;
}
