"use client";

import CompareGrid from "@/components/CompareGrid";
import { useWarehouse } from "@/components/WarehouseProvider";

/* The comparison grid, wired to the shared warehouse.
 *
 * The grid deliberately reads the UNFILTERED agg_group_month rather than the
 * shell's facility/month scope: pinning a facility in the top bar and then
 * putting Facility on an axis would leave a one-row grid, which is not a
 * comparison. The grid owns its own axes and its own third-dimension filter.
 */
export default function ComparePanel() {
  const { data, got, openDrill, aggFor } = useWarehouse();

  return (
    <>
      <p className="page-note">
        Any two of facility, month and KPI group, side by side. The third becomes a filter.
        {!got.gm && " Loading figures…"}
      </p>
      <CompareGrid
        rows={data.gm}
        onCell={(filters, title) => {
          const a = aggFor(filters);
          openDrill({
            title,
            filters,
            expected: { amount: a.amount, n: a.n, source: "Grid cell", compare: true },
          });
        }}
      />
    </>
  );
}
