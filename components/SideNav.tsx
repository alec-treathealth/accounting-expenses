"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/nav";
import Icon from "@/components/Icon";

/* M3 navigation rail, painted entirely in Treat Design System tokens.
 *
 * The active item takes a SOLID accent indicator. That is not a departure from
 * the system's "the accent is a line and a glow, never a flood" rule — it is one
 * of the exactly three exceptions components.css names, alongside a progress
 * fill and a chart series.
 *
 * Three widths, one DOM:
 *   >= 1100px  240px rail, icon + label + badge
 *   >= 760px    72px rail, icon only — the label is CLIPPED, not removed, so the
 *               link keeps its accessible name (the icon is aria-hidden, so
 *               removing the text would leave a nameless link)
 *   <  760px   off-canvas drawer behind the top bar's menu button
 */

export default function SideNav({
  alertCount,
  open,
  onClose,
}: {
  /** Alerts inside the current facility/month filter, or null while loading. */
  alertCount: number | null;
  /** Mobile drawer state. Ignored at >= 760px, where the rail is always shown. */
  open: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="rail" data-open={open ? "true" : "false"} aria-label="Sections">
      <div className="rail-brand">
        <span className="rail-mark" aria-hidden="true" />
        <span className="rail-brand-text">
          <span className="rail-brand-name">Treat Health</span>
          <span className="rail-brand-sub">Expense workspace</span>
        </span>
      </div>

      <ul className="rail-list">
        {NAV.map((item) => {
          const active = pathname === item.href;
          const badge = item.badge === "alerts" ? alertCount : null;
          /* The visible badge is a bare number sitting next to an icon, which
             tells a screen reader nothing. The link's full name says what it
             counts; the number itself is then aria-hidden so it is not read
             twice. */
          const label =
            badge && badge > 0
              ? `${item.label}, ${badge} charge${badge === 1 ? "" : "s"} needing review`
              : item.label;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="rail-item"
                aria-current={active ? "page" : undefined}
                aria-label={label}
                title={item.blurb}
                onClick={onClose}
              >
                <span className="rail-indicator" aria-hidden="true" />
                <Icon name={item.icon} />
                <span className="rail-label">{item.label}</span>
                {badge !== null && badge > 0 && (
                  <span className="rail-badge" aria-hidden="true">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="rail-foot">
        Apr 1 – Aug 11 2026<br />
        August is partial.
      </p>
    </nav>
  );
}
