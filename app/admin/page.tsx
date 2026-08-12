import type { Metadata } from "next";
import Link from "next/link";
import MappingEditor from "@/components/admin/MappingEditor";

export const metadata: Metadata = {
  title: "Account mapping — Treat Health Expenses",
  description: "Edit the account→KPI group taxonomy that the expense dashboard rebuilds from.",
};

export default function AdminPage() {
  return (
    <main className="wrap">
      <header className="top">
        <div>
          <h1>Account → KPI group mapping</h1>
          <div className="sub">
            <span className="mono">map_account_group</span> is the taxonomy the aggregates are
            rebuilt from. Edit a group here, then rebuild — no CSV re-upload.
          </div>
        </div>
        <div className="controls">
          <Link href="/" style={{ color: "var(--ink2)", fontSize: "12.5px" }}>
            ← Back to dashboard
          </Link>
        </div>
      </header>
      <MappingEditor />
    </main>
  );
}
