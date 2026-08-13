/* TreatHealthOS mark — the supplied artwork, both grounds.
 *
 * Two frames around one glyph: an outlined hexagon on the dark ground, and the
 * solid tile on the light one. BOTH ARE RENDERED AND CSS PICKS, rather than
 * React branching on the current ground. That is not a stylistic preference —
 * the ground is restored from localStorage in a layout effect, so at server
 * render time it is unknown, and choosing in JS would hydrate the wrong mark and
 * flash. A `display` swap keyed on [data-ground] costs nothing and cannot be
 * wrong. It is the same reason the app has no themed <img>: a file cannot follow
 * an attribute on <html>.
 *
 * The five brand colours live in design-system/tokens.css as --logo-*, pinned so
 * a ramp adjustment cannot redraw the logo. The frame is currentColor, so it
 * still tracks --color-text.
 */

/** The four facets. Identical in both frames; the tile version sits 2px lower,
 *  which is what the `dy` argument carries. */
function Glyph({ dy = 0 }: { dy?: number }) {
  return (
    <g transform={dy ? `translate(0 ${dy})` : undefined}>
      <polygon points="50,20 68,31 50,42 32,31" fill="var(--logo-teal)" />
      <polygon points="68,31 68,53 50,64 50,42" fill="var(--logo-teal-deep)" />
      <polygon points="50,42 50,64 32,53 32,31" fill="var(--logo-coral)" />
      <polygon points="50,64 66,73 50,82 34,73" fill="var(--logo-coral-light)" />
    </g>
  );
}

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
      /* globals.css sets `svg { width: 100% }` for the dashboard's charts, which
         would stretch this to its container. Pin the box. */
      style={{ width: size, height: size, flex: "none", display: "block" }}
    >
      {/* Dark ground: outlined hexagon. fillOpacity rather than an rgba() —
          currentColor at 8% follows the ground, a fixed white does not. */}
      <g className="logo-on-dark">
        <polygon
          points="50,4 88,26 88,74 50,96 12,74 12,26"
          fill="currentColor"
          fillOpacity={0.08}
          stroke="currentColor"
          strokeWidth={5}
          strokeLinejoin="round"
        />
        <Glyph />
      </g>

      {/* Light ground: the solid tile. */}
      <g className="logo-on-light">
        <rect width="100" height="100" rx="18" fill="var(--logo-tile)" />
        <Glyph dy={2} />
      </g>
    </svg>
  );
}

/** Mark plus wordmark, for the expanded rail. */
export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word">TreatHealthOS</span>
    </span>
  );
}
