"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/* Display preference that lives on <html> as a design-system data attribute:
   data-ground (dark | light). tokens.css and components.css key off it, so
   flipping it re-tokenizes the whole page with no second code path and no
   re-render of anything that does not consume the value.

   Persisted in localStorage and restored in a LAYOUT effect, which runs before
   the browser paints — so a returning user who chose the light ground does not
   see a dark frame first. localStorage is untrusted input like any other, so the
   value is checked against its allowed set before it reaches the DOM.

   Density and motion used to be user-switchable here too. They are now fixed at
   the design-system defaults (compact, motion on), which are represented by the
   ABSENCE of data-density / data-motion — so simply never setting them is what
   pins them. That also means a stale "comfortable" or "off" left in localStorage
   by the old controls is inert rather than stranding someone in a mode with no
   switch to leave it by. The OS reduced-motion setting is still honoured, in
   components.css, exactly as before. */

const GROUNDS = ["dark", "light"] as const;

export type Ground = (typeof GROUNDS)[number];

/** SSR renders the design-system default; this must match <html> in layout. */
const DEFAULT_GROUND: Ground = "dark";

const KEY_GROUND = "ths-ground";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    // Safari private mode throws on localStorage access. A display preference
    // is not worth an error boundary — fall back and carry on.
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore — see read() */
  }
}

export function usePrefs() {
  const [ground, setGroundState] = useState<Ground>(DEFAULT_GROUND);

  // Restore before paint. Deliberately useLayoutEffect, not useEffect: with
  // useEffect the first painted frame uses the SSR default and the saved
  // preference lands a frame later, which reads as a flash.
  useLayoutEffect(() => {
    const g = read(KEY_GROUND, GROUNDS, DEFAULT_GROUND);
    setGroundState(g);
    document.documentElement.setAttribute("data-ground", g);
  }, []);

  // Keep the meta theme-color in step with the ground so mobile browser chrome
  // does not stay dark behind a light page.
  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--color-bg").trim();
    if (bg) meta.setAttribute("content", bg);
  }, [ground]);

  const setGround = useCallback((g: Ground) => {
    setGroundState(g);
    document.documentElement.setAttribute("data-ground", g);
    write(KEY_GROUND, g);
  }, []);

  const toggleGround = useCallback(
    () => setGround(ground === "dark" ? "light" : "dark"),
    [ground, setGround],
  );

  return { ground, setGround, toggleGround };
}
