/* Inline SVG icon set.
 *
 * Deliberately not an icon font and not a package: an icon font is a network
 * request, a FOUT and a screen-reader hazard, and a package would be a third
 * dependency for nine paths. Everything here is currentColor, so an icon takes
 * the colour of whatever nav state it sits in with no per-icon token wiring.
 *
 * Every icon is decorative — the label next to it carries the meaning — so each
 * is aria-hidden and focusable={false}. `focusable` matters: IE/Edge legacy put
 * SVGs in the tab order, and a stray tab stop before every nav item is a real
 * keyboard-navigation regression.
 */

export type IconName =
  | "dashboard"
  | "insights"
  | "compare"
  | "alert"
  | "menu"
  | "close"
  | "contrast"
  | "logout"
  | "upload";

const PATHS: Record<IconName, React.ReactNode> = {
  // Four panes — the overview.
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  // Rising bars — spend intelligence.
  insights: (
    <>
      <path d="M4 20V10" />
      <path d="M10 20V4" />
      <path d="M16 20v-7" />
      <path d="M3 20h18" />
    </>
  ),
  // Two stacks side by side — the comparison grid.
  compare: (
    <>
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
      <path d="M3 9.5h7M14 9.5h7" />
    </>
  ),
  // Bell.
  alert: (
    <>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 4.2-1.2 5.6-1.8 6.2a.9.9 0 0 0 .6 1.55h14.4a.9.9 0 0 0 .6-1.55c-.6-.6-1.8-2-1.8-6.2Z" />
      <path d="M9.9 19.3a2.2 2.2 0 0 0 4.2 0" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12M18 6L6 18" />
    </>
  ),
  // Half-filled circle — the light/dark ground switch.
  contrast: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H14" />
      <path d="M17 8.5 20.5 12 17 15.5" />
      <path d="M20 12h-9" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4.5" />
      <path d="M7.5 9 12 4.5 16.5 9" />
      <path d="M4.5 15v3A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-3" />
    </>
  ),
};

export default function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      /* globals.css sets `svg { width: 100% }` for the dashboard's charts, which
         would stretch every icon to its container. Pin the box here. */
      style={{ width: size, height: size, flex: "none", display: "block" }}
    >
      {PATHS[name]}
    </svg>
  );
}
