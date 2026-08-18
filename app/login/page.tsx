import { Suspense } from "react";
import LoginForm from "./LoginForm";
import { LogoMark } from "@/components/Logo";

/* Server shell around a client form. The form reads `next` via useSearchParams,
   which Next 14 requires to sit inside a Suspense boundary — without one the
   production build fails on this route. */
export default function LoginPage() {
  return (
    <main className="wrap" style={{ maxWidth: 380, marginTop: "12vh" }}>
      <div className="card">
        <div className="card-body">
          <LogoMark size={40} />
          <h1 className="card-title" style={{ margin: "var(--space-4) 0 0" }}>
            TreatHealthOS
          </h1>
          <p className="card-kicker" style={{ marginTop: 2 }}>
            Expense Dashboard
          </p>
          <p className="card-meta" style={{ marginTop: 0, marginBottom: "var(--space-5)" }}>
            Sign in to continue.
          </p>
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
