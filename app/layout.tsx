import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

/* Import order is load-bearing: tokens define the custom properties,
   components.css resolves every value against them, and globals.css is the
   app-specific layer that may override either. */
import "../design-system/tokens.css";
import "../design-system/components.css";
import "./globals.css";

/* The design system specifies Inter (its tnum figures are why numbers align
   without going mono). next/font self-hosts it, so there is no runtime request
   to a third party and no external stylesheet to allow. */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Treat Health — Expense Dashboard",
  description: "Multi-entity expense dashboard for Treat Health residential facilities.",
};

export const viewport: Viewport = {
  /* The ONE sanctioned literal color in component code. Next serializes this
     into a <meta name="theme-color"> tag before any stylesheet is parsed, so it
     cannot be var(--color-bg). It mirrors --color-bg on the dark ground (the
     design-system default); usePrefs() rewrites the tag from the live computed
     token whenever the ground changes, so the two cannot drift on screen.
     Keep this in step with --color-bg in design-system/tokens.css. */
  themeColor: "#131C1D",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/* data-ground="dark" is the design-system default ("light is a preference, not
   a fork"). The ground, density and motion preferences are applied on the
   client by useGround() in components/usePrefs.ts, which restores the saved
   choice in a layout effect — before paint, so a returning user with the light
   ground set does not see a dark frame first.
   No pre-paint inline <script> on purpose: it would be the only inline script
   in the app and the only reason to loosen a future CSP. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-ground="dark" className={inter.variable} suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
