"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { activeItem } from "@/lib/nav";
import { filterAlerts } from "@/lib/alerts";
import WarehouseProvider, { useWarehouse } from "@/components/WarehouseProvider";
import SideNav from "@/components/SideNav";
import TopBar from "@/components/TopBar";
import TxnDrawer from "@/components/TxnDrawer";

/* The application frame: navigation rail, top bar, and the single mounted
 * transaction drawer that any route can open through the warehouse context.
 *
 * Everything lives under one provider so route changes cost no round trips and
 * the filters survive navigation. The drawer is rendered ONCE here rather than
 * per page: two mounted drawers would fight over the focus trap and the body
 * scroll lock they each install.
 */

/** Below this the rail becomes an off-canvas drawer. Must match the
 *  `@media (max-width: 759px)` block in globals.css — the drawer's focus
 *  behaviour is only correct while the CSS is actually hiding the rail. */
const DRAWER_MQ = "(max-width: 759px)";

const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Frame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data, got, facility, month, loadError, read } = useWarehouse();
  const [menuOpen, setMenuOpen] = useState(false);

  const railRef = useRef<HTMLDivElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  const item = activeItem(pathname);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // A navigation is the completion of the menu's purpose, so it closes itself.
  useEffect(() => setMenuOpen(false), [pathname]);

  /* Close when the viewport grows past the drawer breakpoint. Without this,
     opening the menu on a phone and rotating to landscape leaves the scrim
     covering the page while the only control that could dismiss it —
     .topbar-menu — has gone display:none, so the app reads as frozen. It also
     keeps aria-expanded on that button truthful. */
  useEffect(() => {
    const mq = window.matchMedia(DRAWER_MQ);
    const sync = () => {
      if (!mq.matches) setMenuOpen(false);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  /* Focus management for the off-canvas drawer ONLY.
     ---------------------------------------------------------------------------
     The rail precedes its own trigger in the DOM, so without this a keyboard
     user who opens the menu and presses Tab lands on the facility select —
     sitting underneath the scrim, invisible behind the drawer — and walks the
     whole obscured page before ever reaching a nav link. At >= 760px the rail is
     a permanently visible landmark and must NOT be trapped, which is why every
     branch here is gated on the media query. */
  useEffect(() => {
    if (!menuOpen) {
      // Hand focus back to the trigger, but only if we are closing a drawer we
      // actually opened — not on first mount, and not on a plain resize.
      if (wasOpen.current) menuBtnRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    if (!window.matchMedia(DRAWER_MQ).matches) return;
    wasOpen.current = true;

    railRef.current?.querySelector<HTMLElement>("a.rail-item")?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = railRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  /* The badge counts UNREAD alerts inside the current filters — read state is
     what "mark all as read" clears, and a badge that ignored it would make that
     button look broken. null while loading, so the rail shows nothing rather
     than a confident "0" that would read as "nothing needs review". */
  const alertCount = useMemo(
    () =>
      got.alerts
        ? filterAlerts(data.alerts, { facility, month }).filter((a) => !read.has(a.key)).length
        : null,
    [got.alerts, data.alerts, facility, month, read],
  );

  /* While the drawer is open, the rest of the page is behind a scrim and must
     leave the accessibility tree too — otherwise a screen reader's browse mode
     walks straight out of the drawer into content the user cannot see. Gated on
     menuOpen, which the breakpoint effect above forces false at >= 760px. */
  const behindDrawer = menuOpen || undefined;

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>

      <div id="ths-rail" className="rail-host" data-open={menuOpen ? "true" : "false"} ref={railRef}>
        <SideNav alertCount={alertCount} open={menuOpen} onClose={closeMenu} />
      </div>
      {/* Tap-away for the mobile drawer. Hidden from assistive tech: Escape and
          the toggle button are the keyboard paths, and an unlabelled div in the
          a11y tree is noise. */}
      {menuOpen && <div className="rail-scrim" onClick={closeMenu} aria-hidden="true" />}

      <div className="shell-main" aria-hidden={behindDrawer}>
        <TopBar
          title={item?.label ?? "Expense workspace"}
          blurb={item?.blurb ?? ""}
          onMenu={() => setMenuOpen((v) => !v)}
          menuOpen={menuOpen}
          menuRef={menuBtnRef}
        />
        <main id="main" className="shell-content" tabIndex={-1}>
          {loadError && (
            <div className="dd-warn" role="alert" style={{ marginTop: 0 }}>
              {loadError}
            </div>
          )}
          {children}
          <footer>
            Source: “Consolidated transaction detail” export (QuickBooks) · Warehouse: Supabase{" "}
            <span className="mono">accounting-expenses</span> · Totals reconcile to source to the penny.
          </footer>
        </main>
      </div>
    </div>
  );
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <WarehouseProvider
      drill={(ctx, close) => (ctx ? <TxnDrawer ctx={ctx} onClose={close} /> : null)}
    >
      <Frame>{children}</Frame>
    </WarehouseProvider>
  );
}
