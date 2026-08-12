"use client";

import { useState } from "react";
import Dashboard from "@/components/Dashboard";
import Upload from "@/components/Upload";

export default function Page() {
  const [reloadKey, setReloadKey] = useState(0);
  const [showUpload, setShowUpload] = useState(false);

  return (
    <main className="wrap">
      <Dashboard reloadKey={reloadKey} />
      <section style={{ marginTop: 16 }}>
        {!showUpload ? (
          <button onClick={() => setShowUpload(true)}>+ Update data from a new CSV</button>
        ) : (
          <Upload
            onDone={() => {
              setReloadKey((k) => k + 1);
            }}
          />
        )}
      </section>
    </main>
  );
}
