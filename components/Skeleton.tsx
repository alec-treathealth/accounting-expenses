/* Loading placeholders and the staggered entrance, shared by every panel.
 *
 * NEVER RENDER A ZERO WHILE LOADING. On a financial dashboard "$0" is a claim
 * about the business, not a loading state, and a reader who glances at the
 * screen mid-fetch will believe it.
 */

/** Staggered entrance. `ths-rise` has fill-mode `both`, so a delay holds the
 *  element at its from-state until its turn and a row of cards reads as one
 *  movement rather than four simultaneous pops. Both the OS reduced-motion
 *  setting and the design system's motion rules collapse this to ~0ms in
 *  components.css, so it is safe to apply unconditionally. */
export const rise = (i: number) => ({ animationDelay: `${i * 45}ms` });

export function Sk({ className = "", w }: { className?: string; w?: number | string }) {
  return (
    <span
      className={`ths-skeleton ${className}`}
      style={{ display: "block", width: w }}
      aria-hidden="true"
    />
  );
}

/** Placeholder bar rows, sized like the real ones so nothing shifts on arrival. */
export function SkRows({ n }: { n: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading figures…</span>
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          {/* Deterministic pseudo-random widths: a real random() would differ
              between the server render and the client hydration. */}
          <Sk className="sk-line" w={`${58 + ((i * 13) % 34)}%`} />
          <Sk className="sk-line" />
          <Sk className="sk-line" w="70%" />
        </div>
      ))}
    </div>
  );
}
