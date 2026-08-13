"use client";

import { useEffect, useMemo, useState } from "react";
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

function Frame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data, got, facility, month, loadError } = useWarehouse();
  const [menuOpen, setMenuOpen] = useState(false);

  const item = activeItem(pathname);

  // A navigation is the completion of the menu's purpose, so it closes itself.
  useEffect(() => setMenuOpen(false), [pathname]);

  // Escape closes the mobile drawer. Bound on the document because the drawer's
  // own links lose focus the moment a navigation starts.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  /* The badge counts alerts INSIDE the current filters. null while loading, so
     the rail shows nothing rather than a confident "0" that would read as
     "nothing needs review". */
  const alertCount = useMemo(
    () => (got.alerts ? filterAlerts(data.alerts, { facility, month }).length : null),
    [got.alerts, data.alerts, facility, month],
  );

  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>

      <div id="ths-rail" className="rail-host" data-open={menuOpen ? "true" : "false"}>
        <SideNav alertCount={alertCount} open={menuOpen} onClose={() => setMenuOpen(false)} />
      </div>
      {/* Tap-away for the mobile drawer. Hidden from assistive tech: Escape and
          the toggle button are the keyboard paths, and an unlabelled div in the
          a11y tree is noise. */}
      {menuOpen && <div className="rail-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <div className="shell-main">
        <TopBar
          title={item?.label ?? "Expense workspace"}
          blurb={item?.blurb ?? ""}
          onMenu={() => setMenuOpen((v) => !v)}
          menuOpen={menuOpen}
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
