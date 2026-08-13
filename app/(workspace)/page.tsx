import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";

export const metadata: Metadata = {
  title: "Dashboard — Treat Health Expenses",
  description: "How much was spent, on what, and where, across the residential facilities.",
};

/* Re-ingest used to hang off the bottom of this page. It now lives behind the
   Update Data button in the top bar, where it is reachable from every route. */
export default function DashboardPage() {
  return <Dashboard />;
}
