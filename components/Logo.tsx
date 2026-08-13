/* TreatHealthOS mark.
 *
 * TRACED FROM A SCREENSHOT, NOT FROM THE SOURCE ASSET. The proportions and the
 * inner glyph are as close as the supplied image allows; if the real SVG is
 * dropped in, replace the two paths below and nothing else changes — every call
 * site goes through this component.
 *
 * Drawn in currentColor rather than a fixed hex so it inverts with the ground
 * for free, in CSS, with no second asset and no React involvement. That is also
 * why it is inline SVG and not an <img>: a file cannot follow [data-ground].
 */

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
      /* globals.css sets `svg { width: 100% }` for the dashboard's charts, which
         would stretch this to its container. Pin the box. */
      style={{ width: size, height: size, flex: "none", display: "block" }}
    >
      {/* Flat-top hexagon, rounded joins. */}
      <path
        d="M10.1 3.6h11.8a3 3 0 0 1 2.6 1.5l5.9 10.2a3 3 0 0 1 0 3l-5.9 10.2a3 3 0 0 1-2.6 1.5H10.1a3 3 0 0 1-2.6-1.5L1.6 18.3a3 3 0 0 1 0-3L7.5 5.1a3 3 0 0 1 2.6-1.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* Inner glyph: upright stem with a rising diagonal. */}
      <path
        d="M16 9.4v13.2M16 16l5.2-3.4M16 18.6l-4.6-3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark plus wordmark, for the expanded rail and the sign-in screen. */
export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word">TreatHealthOS</span>
    </span>
  );
}
