"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { monthName } from "@/lib/format";
import { PARTIAL_MONTH } from "@/lib/pivot";
import { useWarehouse } from "@/components/WarehouseProvider";
import Icon from "@/components/Icon";
import { usePrefs } from "@/components/usePrefs";
import UpdateDataDialog from "@/components/UpdateDataDialog";

/* The one place the facility and month filters live.
 *
 * They are global rather than per-page on purpose: it is what lets the alert
 * badge mean "needing review IN WHAT I AM LOOKING AT" and what lets a user carry
 * a facility from the Dashboard into Expense Intelligence without re-picking it.
 */

export default function TopBar({
  title,
  blurb,
  onMenu,
  menuOpen,
  menuRef,
}: {
  title: string;
  blurb: string;
  onMenu: () => void;
  menuOpen: boolean;
  /** The shell needs this to hand focus back when the drawer closes. */
  menuRef?: React.Ref<HTMLButtonElement>;
}) {
  const { facility, setFacility, month, setMonth, facilities, months, got } = useWarehouse();
  const { ground, toggleGround } = usePrefs();
  const [updating, setUpdating] = useState(false);
  const router = useRouter();

  async function signOut() {
    await getSupabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="topbar">
      <button
        ref={menuRef}
        className="btn btn-ghost btn-icon topbar-menu"
        onClick={onMenu}
        aria-expanded={menuOpen}
        aria-controls="ths-rail"
        aria-label={menuOpen ? "Close sections menu" : "Open sections menu"}
      >
        <Icon name={menuOpen ? "close" : "menu"} />
      </button>

      <div className="topbar-title">
        <h1>{title}</h1>
        <p className="topbar-blurb">{blurb}</p>
      </div>

      <div className="topbar-controls">
        <label className="sr-only" htmlFor="ths-facility">Facility</label>
        <select
          id="ths-facility"
          className="input"
          value={facility}
          onChange={(e) => setFacility(e.target.value)}
          disabled={!got.gm && !got.dim}
        >
          <option value="All">All facilities</option>
          {facilities.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>

        <label className="sr-only" htmlFor="ths-month">Month</label>
        <select
          id="ths-month"
          className="input"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          disabled={!got.gm}
        >
          <option value="All">All months</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthName(m)} {m.slice(0, 4)}
              {m === PARTIAL_MONTH ? " (partial)" : ""}
            </option>
          ))}
        </select>

        {/* The one filled button in the app, and the design system allows
            exactly one per screen. It is the action that makes every other
            figure current, so it belongs at the top of every route rather than
            at the bottom of one of them. */}
        <button className="btn btn-update" onClick={() => setUpdating(true)}>
          <Icon name="upload" size={16} />
          Update Data
        </button>

        <button
          className="btn btn-ghost btn-icon"
          onClick={toggleGround}
          aria-label={`Switch to the ${ground === "dark" ? "light" : "dark"} ground`}
        >
          <Icon name="contrast" />
        </button>

        <button className="btn btn-ghost btn-icon" onClick={signOut} aria-label="Sign out">
          <Icon name="logout" />
        </button>
      </div>

      {updating && <UpdateDataDialog onClose={() => setUpdating(false)} />}
    </header>
  );
}
