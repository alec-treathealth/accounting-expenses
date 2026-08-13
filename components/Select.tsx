"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

/* A select painted in the design system rather than by the operating system.
 *
 * A native <select> renders its list with platform chrome — the iOS sheet, the
 * Windows combobox — which is the one control on the page that cannot be
 * tokenised, so on a dense financial screen it is the thing that looks bolted
 * on. This is a button plus a listbox, styled like everything else.
 *
 * A custom select is only worth building if it is at least as good as the native
 * one to operate, so it implements the full APG listbox pattern:
 *   Enter / Space / ArrowUp / ArrowDown / Home / End  open and move
 *   Escape                                            closes, keeps the value
 *   Tab                                               closes, commits nothing
 *   printable characters                              type-ahead, 700ms window
 * The trigger is aria-labelled, the list is a real listbox with real options,
 * and the active option is wired through aria-activedescendant so a screen
 * reader tracks the highlight without focus ever leaving the trigger.
 */

export type SelectOption = { value: string; label: string };

const TYPEAHEAD_MS = 700;

export default function Select({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  className = "",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Accessible name. Rendered visually only if the caller has no own label. */
  label: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  const auto = useId();
  const baseId = id ?? `sel-${auto.replace(/:/g, "")}`;
  const listId = `${baseId}-list`;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((o) => o.value === value)),
    [options, value],
  );
  const current = options[selectedIndex];

  const openList = useCallback(() => {
    if (disabled) return;
    setActive(selectedIndex);
    setOpen(true);
  }, [disabled, selectedIndex]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  const commit = useCallback(
    (i: number) => {
      const opt = options[i];
      if (opt) onChange(opt.value);
      close();
    },
    [options, onChange, close],
  );

  // Close on an outside press. Pointerdown, not click: a click listener fires
  // after the browser has already moved focus, which makes the popup flicker.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Keep the highlighted option in view when the list is longer than its box.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openList();
      }
      return;
    }

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        // stopPropagation: this component is used inside the transaction
        // drawer, whose document-level Escape handler would otherwise close the
        // whole dialog when the user only meant to dismiss the list.
        e.stopPropagation();
        close();
        return;
      case "Tab":
        setOpen(false);
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        return;
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, options.length - 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(options.length - 1);
        return;
    }

    // Type-ahead. Matches from the option AFTER the current one so repeatedly
    // pressing the same letter cycles through the options starting with it,
    // which is what a native select does.
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      const text = now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + e.key : e.key;
      typed.current = { text, at: now };
      const needle = text.toLowerCase();
      const from = text.length === 1 ? active + 1 : active;
      for (let n = 0; n < options.length; n++) {
        const i = (from + n) % options.length;
        if (options[i].label.toLowerCase().startsWith(needle)) {
          setActive(i);
          break;
        }
      }
    }
  };

  return (
    <div className={`sel ${className}`} ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        id={baseId}
        className="sel-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="sel-value">{current?.label ?? ""}</span>
        <svg
          className="sel-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={{ width: 12, height: 12, flex: "none", display: "block" }}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul className="sel-list" id={listId} role="listbox" aria-label={label} ref={listRef}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              data-active={i === active ? "true" : undefined}
              className="sel-opt"
              /* pointerdown, not click: the outside-press listener above runs on
                 pointerdown, and a click handler here would fire after it had
                 already closed the list. */
              onPointerDown={(e) => {
                e.preventDefault();
                commit(i);
              }}
              onPointerEnter={() => setActive(i)}
            >
              <span className="sel-opt-label">{o.label}</span>
              {o.value === value && (
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true" focusable="false"
                  style={{ width: 14, height: 14, flex: "none", display: "block" }}
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
