"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { monthName } from "@/lib/format";
import { partialMonth } from "@/lib/pivot";
import { useWarehouse } from "@/components/WarehouseProvider";
import Icon from "@/components/Icon";
import { usePrefs } from "@/components/usePrefs";
import UpdateDataDialog from "@/components/UpdateDataDialog";
import Select from "@/components/Select";

/* The one place the facility and month filters live.
 *
 * They are global rather than per-page on purpose: it is what lets the alert
 * badge mean "needing review IN WHAT I AM LOOKING AT" and what lets a user carry
 * a facility from the Dashboard into Card Spend without re-picking it.
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
        <Select
          id="ths-facility"
          label="Facility"
          value={facility}
          disabled={!got.gm && !got.dim}
          onChange={setFacility}
          options={[
            { value: "All", label: "All facilities" },
            ...facilities.map((f) => ({ value: f, label: f })),
          ]}
        />

        <Select
          id="ths-month"
          label="Month"
          value={month}
          disabled={!got.gm}
          onChange={setMonth}
          options={[
            { value: "All", label: "All months" },
            ...months.map((m) => ({
              value: m,
              label: `${monthName(m)} ${m.slice(0, 4)}${m === partialMonth(months) ? " (partial)" : ""}`,
            })),
          ]}
        />

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
