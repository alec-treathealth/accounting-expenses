"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/nav";
import Icon from "@/components/Icon";
import Logo, { LogoMark } from "@/components/Logo";

/* M3 navigation rail, painted entirely in Treat Design System tokens.
 *
 * COLLAPSED IS THE DEFAULT. Four sections do not earn a 240px column of mostly
 * whitespace on every screen; the labels are one day's learning and the content
 * width is permanent. Expanding is a choice and it persists.
 *
 * Collapsed, every item shows a hover/focus label chip beside it — which is not
 * decoration but the thing that makes an icon-only rail usable, and the reason
 * the rail does not need to be expanded to be learnable.
 *
 * The active item takes a SOLID accent indicator. That is not a departure from
 * the system's "the accent is a line and a glow, never a flood" rule — it is one
 * of the exactly three exceptions components.css names, alongside a progress
 * fill and a chart series.
 */

export default function SideNav({
  alertCount,
  expanded,
  onToggle,
  onClose,
}: {
  /** Alerts inside the current facility/month filter, or null while loading. */
  alertCount: number | null;
  /** Desktop rail width. Ignored below 760px, where the rail is a drawer. */
  expanded: boolean;
  onToggle: () => void;
  /** Closes the mobile drawer after a navigation. */
  onClose: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="rail" aria-label="Sections">
      <div className="rail-brand">
        {/* The mark IS the expand control. Collapsed, it is the only thing on
            screen, so giving it the job keeps the promise that nothing else is
            visible — and a logo that reveals the menu is a pattern people
            already know. Hidden from the drawer below 760px, where the top
            bar's own button owns the same job. */}
        <button
          type="button"
          className="rail-logo"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse the menu" : "Expand the menu"}
        >
          {expanded ? <Logo /> : <LogoMark />}
          {!expanded && <span className="rail-tip">Expand menu</span>}
        </button>

        {expanded && (
          <button type="button" className="rail-close" onClick={onToggle} aria-label="Collapse the menu">
            <Icon name="close" size={16} />
          </button>
        )}
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
                onClick={onClose}
              >
                <span className="rail-indicator" aria-hidden="true" />
                <span className="rail-icon">
                  <Icon name={item.icon} />
                </span>
                <span className="rail-label">{item.label}</span>
                {badge !== null && badge > 0 && (
                  <span className="rail-badge" aria-hidden="true">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
                {/* The hover/focus label. aria-hidden because the link already
                    carries the full name — announcing it twice is noise. */}
                <span className="rail-tip" aria-hidden="true">
                  {item.label}
                  {badge !== null && badge > 0 && <span className="rail-tip-badge">{badge}</span>}
                </span>
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
