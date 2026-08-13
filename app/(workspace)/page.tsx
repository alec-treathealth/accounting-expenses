import type { Metadata } from "next";
import Dashboard from "@/components/Dashboard";
import UploadPanel from "@/components/UploadPanel";

export const metadata: Metadata = {
  title: "Dashboard — Treat Health Expenses",
  description: "How much was spent, on what, and where, across the residential facilities.",
};

export default function DashboardPage() {
  return (
    <>
      <Dashboard />
      <UploadPanel />
    </>
  );
}
