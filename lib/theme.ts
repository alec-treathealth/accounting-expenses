/* ============================================================================
   TREAT DESIGN SYSTEM — TYPED TOKEN ACCESSORS
   v2.1 · "Bright Teal"

   Token NAMES only. The values live in design-system/tokens.css. There is not a
   single hex in this file, and there must never be one — that is what makes the
   light / dark / density / contrast grounds work without a second code path.

   Kept 1:1 with the design-system source (`tokens.ts`) so a future sync is a
   copy, not a merge. The ONE addition for this app is CHART slots 7 and 8: the
   expense taxonomy has eight KPI groups and the shipped series stops at six.
   Both new slots are existing ramp steps on the shared lightness scale.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   HELPERS
--------------------------------------------------------------------------- */

/** Low-emphasis fill of any token. Both grounds stay correct because
 *  color-mix resolves against the live custom property, not a snapshot.
 *  `tint(T.accent, 12)` → a 12% accent wash. */
export const tint = (color: string, pct = 12) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** Mix a token toward the current ground rather than toward transparency.
 *  Use when the element sits over another translucent layer and you need the
 *  fill to stay opaque. */
export const solid = (color: string, pct = 12) =>
  `color-mix(in srgb, ${color} ${pct}%, var(--color-surface))`;

/** A 1px ring in any token color, for elements that must not shift layout. */
export const ring = (color: string, pct = 100) =>
  `inset 0 0 0 1px ${pct === 100 ? color : tint(color, pct)}`;

/* ---------------------------------------------------------------------------
   TOKENS
--------------------------------------------------------------------------- */
export const T = {
  /* Ground */
  bg: "var(--color-bg)",
  surface: "var(--color-surface)",
  surfaceRaised: "var(--color-surface-raised)",
  text: "var(--color-text)",

  /* Accents — `accent` and `accent2` auto-step for the light ground.
     The numbered steps do NOT: they are absolute positions on the ramp. */
  accent: "var(--color-accent)",
  accent2: "var(--color-accent-2)",

  /* Neutrals */
  n100: "var(--color-neutral-100)", n200: "var(--color-neutral-200)",
  n300: "var(--color-neutral-300)", n400: "var(--color-neutral-400)",
  n500: "var(--color-neutral-500)", n600: "var(--color-neutral-600)",
  n700: "var(--color-neutral-700)", n800: "var(--color-neutral-800)",
  n900: "var(--color-neutral-900)",

  /* Accent ramp */
  a100: "var(--color-accent-100)", a200: "var(--color-accent-200)",
  a300: "var(--color-accent-300)", a400: "var(--color-accent-400)",
  a500: "var(--color-accent-500)", a600: "var(--color-accent-600)",
  a700: "var(--color-accent-700)", a800: "var(--color-accent-800)",
  a900: "var(--color-accent-900)",

  /* Accent-2 (coral) ramp — decorative only, never severity */
  a2_100: "var(--color-accent-2-100)", a2_200: "var(--color-accent-2-200)",
  a2_300: "var(--color-accent-2-300)", a2_400: "var(--color-accent-2-400)",
  a2_500: "var(--color-accent-2-500)", a2_600: "var(--color-accent-2-600)",
  a2_700: "var(--color-accent-2-700)", a2_800: "var(--color-accent-2-800)",
  a2_900: "var(--color-accent-2-900)",

  /* Danger ramp — severity only, never decoration */
  d100: "var(--color-danger-100)", d200: "var(--color-danger-200)",
  d300: "var(--color-danger-300)", d400: "var(--color-danger-400)",
  d500: "var(--color-danger-500)", d600: "var(--color-danger-600)",
  d700: "var(--color-danger-700)", d800: "var(--color-danger-800)",
  d900: "var(--color-danger-900)",

  /* Status */
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  info: "var(--color-info)",
  muted: "var(--color-muted)",

  /* Structure */
  divider: "var(--color-divider)",
  section: "var(--color-section)",
  sectionGlow: "var(--color-section-glow)",
  sectionGhost: "var(--color-section-ghost)",

  /* Elevation */
  shadowSm: "var(--shadow-sm)",
  shadowMd: "var(--shadow-md)",
  shadowLg: "var(--shadow-lg)",
  shadowAccent: "var(--shadow-accent)",

  /* Radius */
  rSm: "var(--radius-sm)", rMd: "var(--radius-md)", rLg: "var(--radius-lg)",

  /* Space */
  s1: "var(--space-1)", s2: "var(--space-2)", s3: "var(--space-3)",
  s4: "var(--space-4)", s6: "var(--space-6)", s8: "var(--space-8)",

  /* Type */
  fontHeading: "var(--font-heading)",
  fontBody: "var(--font-body)",
  fontMono: "var(--font-mono)",

  /* Motion */
  ease: "var(--ease)",
  dur1: "var(--dur-1)", dur2: "var(--dur-2)", dur3: "var(--dur-3)",
} as const;

/* ---------------------------------------------------------------------------
   TYPE SCALE
--------------------------------------------------------------------------- */
export const TYPE = {
  size: {
    display: "var(--size-display)",
    h2: "var(--size-h2)", h3: "var(--size-h3)", h4: "var(--size-h4)",
    h5: "var(--size-h5)", h6: "var(--size-h6)",
    kpi: "var(--size-kpi)",
    body: "var(--size-body)", bodySm: "var(--size-body-sm)",
    ui: "var(--size-ui)", uiSm: "var(--size-ui-sm)",
    meta: "var(--size-meta)", label: "var(--size-label)",
    tag: "var(--size-tag)",
  },
  leading: {
    display: "var(--leading-display)", heading: "var(--leading-heading)",
    snug: "var(--leading-snug)", body: "var(--leading-body)",
    flat: "var(--leading-flat)",
  },
  tracking: {
    display: "var(--tracking-display)", heading: "var(--tracking-heading)",
    body: "var(--tracking-body)", flat: "var(--tracking-flat)",
    label: "var(--tracking-label)", eyebrow: "var(--tracking-eyebrow)",
    code: "var(--tracking-code)", codeWide: "var(--tracking-code-wide)",
  },
  weight: {
    regular: "var(--weight-regular)",
    medium: "var(--weight-medium)",
    semibold: "var(--weight-semibold)",
  },
} as const;

/* ---------------------------------------------------------------------------
   TEXT PRESETS
   One entry per text style. Spread onto a style prop:
       <span style={{ ...TEXT.label, color: ROLE.metaText }}>
   Color is NEVER included: pick a ROLE separately, or the preset would not
   survive a ground flip.
--------------------------------------------------------------------------- */
export const TEXT = {
  display: {
    fontFamily: T.fontHeading, fontSize: TYPE.size.display,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.heading,
    letterSpacing: TYPE.tracking.heading,
  },
  h2: {
    fontFamily: T.fontHeading, fontSize: TYPE.size.h2,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.heading,
    letterSpacing: TYPE.tracking.heading,
  },
  h3: {
    fontFamily: T.fontHeading, fontSize: TYPE.size.h3,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.heading,
    letterSpacing: TYPE.tracking.heading,
  },
  h4: {
    fontFamily: T.fontHeading, fontSize: TYPE.size.h4,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.heading,
    letterSpacing: TYPE.tracking.heading,
  },
  h5: {
    fontFamily: T.fontHeading, fontSize: TYPE.size.h5,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.heading,
    letterSpacing: TYPE.tracking.heading,
  },
  /** Uppercase eyebrow. */
  h6: {
    fontFamily: T.fontHeading, fontSize: TYPE.size.h6,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.heading,
    letterSpacing: TYPE.tracking.eyebrow, textTransform: "uppercase" as const,
  },
  body: {
    fontFamily: T.fontBody, fontSize: TYPE.size.body,
    fontWeight: TYPE.weight.regular, lineHeight: TYPE.leading.body,
    letterSpacing: TYPE.tracking.body,
  },
  bodySm: {
    fontFamily: T.fontBody, fontSize: TYPE.size.bodySm,
    fontWeight: TYPE.weight.regular, lineHeight: TYPE.leading.body,
    letterSpacing: TYPE.tracking.body,
  },
  /** Buttons, inputs, table cells — the workhorse UI size. */
  ui: {
    fontFamily: T.fontBody, fontSize: TYPE.size.ui,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.flat,
  },
  uiSm: {
    fontFamily: T.fontBody, fontSize: TYPE.size.uiSm,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.flat,
  },
  meta: {
    fontFamily: T.fontBody, fontSize: TYPE.size.meta,
    fontWeight: TYPE.weight.regular, lineHeight: TYPE.leading.body,
  },
  /** Uppercase field label / table header. */
  label: {
    fontFamily: T.fontBody, fontSize: TYPE.size.label,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.body,
    letterSpacing: TYPE.tracking.label, textTransform: "uppercase" as const,
  },
  tag: {
    fontFamily: T.fontBody, fontSize: TYPE.size.tag,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.snug,
  },
  /** Big tabular number. Tracking is negative AND figures are tabular. */
  kpi: {
    fontFamily: T.fontHeading, fontSize: TYPE.size.kpi,
    fontWeight: TYPE.weight.medium, lineHeight: TYPE.leading.display,
    letterSpacing: TYPE.tracking.display,
    fontVariantNumeric: "tabular-nums" as const,
  },
  /** Any inline number that must align in a column. */
  numeric: {
    fontVariantNumeric: "tabular-nums" as const,
    letterSpacing: TYPE.tracking.flat,
  },
  /** Account numbers, transaction refs — the character grid is the info. */
  code: {
    fontFamily: T.fontMono, fontVariantNumeric: "tabular-nums" as const,
    letterSpacing: TYPE.tracking.code,
  },
  codeInput: {
    fontFamily: T.fontMono, fontSize: TYPE.size.body,
    fontWeight: TYPE.weight.medium, letterSpacing: TYPE.tracking.codeWide,
    textTransform: "uppercase" as const,
  },
} as const;

/* ---------------------------------------------------------------------------
   SEMANTIC ROLES
   Prefer these over reaching for a raw ramp step. If you find yourself writing
   `T.a500` in a component, ask whether the meaning belongs here instead.

   Every value is a SEMANTIC custom property (--text-*, --fill-*), never a
   numbered ramp step. That is load-bearing: the numbered steps are absolute
   positions on the shared OKLCH lightness scale, so they cannot invert for the
   light ground. The --text-* properties are restated under
   [data-ground="light"] and so read correctly on both.
--------------------------------------------------------------------------- */
export const ROLE = {
  /** Text that must be read. 12.1:1 dark · 12.0:1 light. */
  bodyText: "var(--text-body)",
  /** Secondary copy, table cells, descriptions. 10.0:1 · 7.3:1. */
  subText: "var(--text-secondary)",
  /** Labels, captions, timestamps, units. 7.0:1 · 7.3:1. */
  metaText: "var(--text-meta)",
  /** Disabled ONLY — 4.0:1 · 4.1:1, below the AA body floor by design.
   *  Never put content a user must read on this. */
  disabledText: "var(--text-disabled)",

  /** Accent-colored paragraph text. NOT T.accent, which is tuned for chrome. */
  accentText: "var(--text-accent)",
  /** Danger-colored paragraph text. */
  dangerText: "var(--text-danger)",

  /** Hairline between rows and cells. */
  hairline: "var(--hairline)",
  /** Visible border on an interactive element. */
  border: T.divider,
  /** Border on a focused or selected element. */
  borderActive: T.accent,

  /** The wash behind a selected row or active nav item. */
  selectedFill: "var(--fill-selected)",
  /** Hover wash on a neutral surface. */
  hoverFill: "var(--fill-hover)",
  /** Pressed wash. */
  activeFill: "var(--fill-active)",
} as const;

/* ---------------------------------------------------------------------------
   TONE MAP
   Each tone resolves to a text color, a fill, and a border so pills, buttons
   and badges stay consistent without every call site re-deriving them.

   NOTE the split: "accent2" is decorative warmth. "danger" is severity.
   Coral has exactly one job — attention — and that is now literally true,
   because coral and danger are different colors.

   Foregrounds are semantic, not numbered steps — same reason as ROLE.
   accent2 is the exception: there is no --text-accent-2 role because coral
   carries no severity and is never paragraph text. It uses the semantic
   --color-accent-2, which does flip.
--------------------------------------------------------------------------- */
export type ToneName =
  | "ok" | "warn" | "danger" | "info" | "neutral" | "accent" | "accent2";

export interface ToneSpec {
  /** Foreground — text and icons. */
  fg: string;
  /** Low-emphasis background wash. */
  fill: string;
  /** 1px border / ring color. */
  border: string;
}

export const TONE: Record<ToneName, ToneSpec> = {
  ok:      { fg: T.ok,               fill: tint(T.ok, 14),      border: tint(T.ok, 40) },
  warn:    { fg: T.warn,             fill: tint(T.warn, 14),    border: tint(T.warn, 40) },
  danger:  { fg: ROLE.dangerText,    fill: tint(T.danger, 14),  border: tint(T.danger, 40) },
  info:    { fg: T.info,             fill: tint(T.info, 14),    border: tint(T.info, 40) },
  neutral: { fg: ROLE.subText,       fill: tint(T.text, 7),     border: T.divider },
  accent:  { fg: ROLE.accentText,    fill: tint(T.accent, 14),  border: tint(T.accent, 40) },
  accent2: { fg: T.accent2,          fill: tint(T.accent2, 14), border: tint(T.accent2, 40) },
};

/* ---------------------------------------------------------------------------
   CHART SERIES
   Ordered for categorical data. The first four stay distinguishable under
   deuteranopia, which is why info (blue) comes before warn (amber) rather
   than after. Pass `CHART[i % CHART.length]`.
--------------------------------------------------------------------------- */
export const CHART = [
  "var(--chart-1)", "var(--chart-2)", "var(--chart-3)",
  "var(--chart-4)", "var(--chart-5)", "var(--chart-6)",
  "var(--chart-7)", "var(--chart-8)",
] as const;

export const CHART_GRID = "var(--chart-grid)";
export const CHART_AXIS = "var(--chart-axis)";

/** Directional color for a delta. Financial convention: up is good unless the
 *  metric is a cost, hence the explicit `invert`. Expense figures are costs,
 *  so callers in this app pass invert = true. */
export const deltaColor = (v: number, invert = false) =>
  v === 0 ? ROLE.metaText : (v > 0) !== invert ? T.ok : T.danger;
