"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/* Display preferences that live on <html> as design-system data attributes:
   data-ground (dark | light), data-density (compact | comfortable) and
   data-motion (on | off). tokens.css and components.css key off these, so
   flipping one re-tokenizes the whole page with no second code path and no
   re-render of anything that does not consume the value.

   Persisted in localStorage and restored in a LAYOUT effect, which runs before
   the browser paints — so a returning user who chose the light ground does not
   see a dark frame first. localStorage is untrusted input like any other, so
   every value is checked against its allowed set before it reaches the DOM. */

const GROUNDS = ["dark", "light"] as const;
const DENSITIES = ["compact", "comfortable"] as const;
const MOTIONS = ["on", "off"] as const;

export type Ground = (typeof GROUNDS)[number];
export type Density = (typeof DENSITIES)[number];
export type Motion = (typeof MOTIONS)[number];

/** SSR renders the design-system defaults; these must match <html> in layout. */
const DEFAULTS = { ground: "dark" as Ground, density: "compact" as Density, motion: "on" as Motion };

const KEY = { ground: "ths-ground", density: "ths-density", motion: "ths-motion" } as const;

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

/** Only "compact" density and "on" motion are the absence of an attribute, so
 *  those two clear rather than set. Keeps the DOM honest about what is default. */
function apply(attr: string, value: string, isDefault: boolean) {
  const el = document.documentElement;
  if (isDefault) el.removeAttribute(attr);
  else el.setAttribute(attr, value);
}

export function usePrefs() {
  const [ground, setGroundState] = useState<Ground>(DEFAULTS.ground);
  const [density, setDensityState] = useState<Density>(DEFAULTS.density);
  const [motion, setMotionState] = useState<Motion>(DEFAULTS.motion);

  // Restore before paint. Deliberately useLayoutEffect, not useEffect: with
  // useEffect the first painted frame uses the SSR default and the saved
  // preference lands a frame later, which reads as a flash.
  useLayoutEffect(() => {
    const g = read(KEY.ground, GROUNDS, DEFAULTS.ground);
    const d = read(KEY.density, DENSITIES, DEFAULTS.density);
    const m = read(KEY.motion, MOTIONS, DEFAULTS.motion);
    setGroundState(g);
    setDensityState(d);
    setMotionState(m);
    document.documentElement.setAttribute("data-ground", g);
    apply("data-density", d, d === "compact");
    apply("data-motion", m, m === "on");
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
    write(KEY.ground, g);
  }, []);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    apply("data-density", d, d === "compact");
    write(KEY.density, d);
  }, []);

  const setMotion = useCallback((m: Motion) => {
    setMotionState(m);
    apply("data-motion", m, m === "on");
    write(KEY.motion, m);
  }, []);

  const toggleGround = useCallback(
    () => setGround(ground === "dark" ? "light" : "dark"),
    [ground, setGround],
  );

  return { ground, density, motion, setGround, setDensity, setMotion, toggleGround };
}
