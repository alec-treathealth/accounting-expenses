"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";

export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const { error } = await getSupabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) {
      /* Deliberately does not distinguish "unknown email" from "wrong password":
         that difference tells an attacker which addresses have accounts. */
      setError("That email and password combination was not recognised.");
      setBusy(false);
      return;
    }

    /* `next` is attacker-influenceable (it comes from the query string), so only
       same-site absolute paths are honoured — otherwise this is an open redirect. */
    const raw = params.get("next") || "/";
    const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <label className="field">
        <span>Email</span>
        <input
          className="input"
          type="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </label>

      <label className="field">
        <span>Password</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </label>

      {error && (
        <p role="alert" style={{ color: "var(--color-danger)", margin: 0, fontSize: "var(--size-ui-sm)" }}>
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-solid btn-block" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
