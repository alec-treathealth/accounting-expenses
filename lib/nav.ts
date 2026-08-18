import type { IconName } from "@/components/Icon";

// ---------------------------------------------------------------------------
// The workspace's information architecture, in one place.
//
// Four sections because four questions. Keeping this as data rather than JSX
// means the rail, the mobile menu and the document title all read the same
// list, so a fifth section cannot appear in one and be missing from another.
// ---------------------------------------------------------------------------

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Shown under the page heading. Also the item's title attribute in the rail. */
  blurb: string;
  /** Only the alerts item carries a count today; the field keeps the rail generic. */
  badge?: "alerts";
};

export const NAV: readonly NavItem[] = [
  {
    href: "/",
    label: "Dashboard",
    icon: "dashboard",
    blurb: "How much was spent, on what, and where.",
  },
  {
    href: "/intelligence",
    label: "Card Spend",
    icon: "insights",
    blurb: "Ramp card spend by cardholder, and where it went.",
  },
  {
    href: "/compare",
    label: "Compare",
    icon: "compare",
    blurb: "Any two of facility, month and KPI group, side by side.",
  },
  {
    href: "/alerts",
    label: "Expense Alerts",
    icon: "alert",
    blurb: "Ramp charges that sit outside the cardholder's own norm.",
    badge: "alerts",
  },
];

/**
 * The nav item for a pathname.
 *
 * Exact match, never `startsWith`. With prefix matching "/" is a prefix of every
 * route, so the Dashboard item would render as active on all four pages.
 */
export function activeItem(pathname: string): NavItem | undefined {
  return NAV.find((n) => n.href === pathname);
}
