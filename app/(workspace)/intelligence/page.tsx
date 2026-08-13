import type { Metadata } from "next";
import RampPeople from "@/components/RampPeople";

export const metadata: Metadata = {
  title: "Expense Intelligence — Treat Health Expenses",
  description: "Ramp card spend by cardholder, with the merchants and KPI groups behind it.",
};

export default function IntelligencePage() {
  return <RampPeople />;
}
