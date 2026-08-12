import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Treat Health — Expense Dashboard",
  description: "Multi-entity expense dashboard for Treat Health residential facilities.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Treat Expenses", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0d0d0d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
