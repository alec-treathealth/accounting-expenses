import AppShell from "@/components/AppShell";

/* Everything in this route group shares one shell — one navigation rail, one set
 * of filters, one warehouse read, one transaction drawer. /login and /admin sit
 * OUTSIDE the group on purpose: a sign-in screen with a navigation rail behind
 * it offers routes the visitor cannot reach, and the admin mapping editor is a
 * separate tool with its own page chrome.
 */
export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
