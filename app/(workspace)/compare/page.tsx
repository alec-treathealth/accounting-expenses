import type { Metadata } from "next";
import ComparePanel from "@/components/ComparePanel";

export const metadata: Metadata = {
  title: "Compare — Treat Health Expenses",
  description: "Compare facilities, months and KPI groups against one another.",
};

export default function ComparePage() {
  return <ComparePanel />;
}
