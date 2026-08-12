"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Dashboard from "@/components/Dashboard";
import Upload from "@/components/Upload";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

export default function Page() {
  const [reloadKey, setReloadKey] = useState(0);
  const [showUpload, setShowUpload] = useState(false);
  const router = useRouter();

  /* Sign-out lives here rather than inside Dashboard so that component stays a
     pure rendering concern with no auth awareness. */
  async function signOut() {
    await getSupabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <main className="wrap">
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "var(--space-3)" }}>
        <button className="btn btn-ghost btn-sm" onClick={signOut}>
          Sign out
        </button>
      </div>
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
