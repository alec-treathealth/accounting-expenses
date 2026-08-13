"use client";

import { useState } from "react";
import Upload from "@/components/Upload";
import { useWarehouse } from "@/components/WarehouseProvider";

/* CSV re-ingest, collapsed until asked for.
 *
 * On success it calls the warehouse's reload() rather than owning a reloadKey of
 * its own — every route reads the same cached datasets, so a refresh has to
 * invalidate the shared cache, not one page's copy of it.
 */
export default function UploadPanel() {
  const [open, setOpen] = useState(false);
  const { reload } = useWarehouse();

  return (
    <section className="upload-panel">
      {!open ? (
        <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
          + Update data from a new CSV
        </button>
      ) : (
        <Upload onDone={reload} />
      )}
    </section>
  );
}
