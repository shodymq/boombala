"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Sends the session CSRF token (our token, not FastAPI's) in a header. Same-origin POST only. */
export function ParentLogoutButton({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/parent/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
          body: "{}",
        });
        router.replace("/account/login");
        router.refresh();
      }}
      className="rounded-full border border-grape-300 px-4 py-2 text-sm font-bold text-grape-800 disabled:opacity-60"
    >
      Выйти
    </button>
  );
}
