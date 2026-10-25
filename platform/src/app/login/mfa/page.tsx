import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { beginEnrollment, isEnrolled } from "@/core/mfa";
import { getPendingSession, getSession } from "@/server/dal";
import { getPool } from "@/server/db";
import { mfaKey, passkeysAvailable } from "@/server/env";
import { activePasskeyCount } from "@/core/passkeys";
import { PasskeyLogin } from "../passkey-login";
import { MfaForm } from "./mfa-form";

export const metadata: Metadata = { title: "Второй фактор" };

export default async function MfaPage() {
  // No redirect for a person who just finished: the action that completed the login sets the session cookie, the page is
  // rendered again, and the recovery codes shown by the form (client state) must not be thrown away by a redirect.
  const signedIn = (await getSession()) !== null;
  const pending = signedIn ? null : await getPendingSession();
  if (!signedIn && !pending) redirect("/login");
  const pool = getPool();
  const enrolled = pending ? await isEnrolled(pool, pending.user.id) : true;
  const enrollment = pending && !enrolled ? await beginEnrollment(pool, pending.user.id, mfaKey) : null;
  // A person with a registered passkey may finish the sign-in with it instead of typing a code.
  const hasPasskey = passkeysAvailable && pending ? (await activePasskeyCount(pool, pending.user.id)) > 0 : false;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <div className="rounded-[2rem] border border-line bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">Boom Bala</p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-grape-800">Подтверждение входа</h1>
        <MfaForm enrolled={enrolled} signedIn={signedIn} secret={enrollment?.secret} otpauth={enrollment?.otpauth} />
        {hasPasskey ? <PasskeyLogin pending /> : null}
      </div>
    </main>
  );
}
