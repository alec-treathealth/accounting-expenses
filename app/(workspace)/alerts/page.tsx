import type { Metadata } from "next";
import AlertsFeed from "@/components/AlertsFeed";

export const metadata: Metadata = {
  title: "Expense Alerts — Treat Health Expenses",
  description: "Ramp charges that sit outside the cardholder's own spending norm.",
};

export default function AlertsPage() {
  return <AlertsFeed />;
}
