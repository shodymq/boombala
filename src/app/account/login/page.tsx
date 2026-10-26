import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ParentLoginForm } from "@/components/parent/ParentLoginForm";
import { SessionStoreUnavailable } from "@/lib/parent/core";
import { currentSession, parentState } from "@/lib/parent/server";

export const metadata: Metadata = { title: "Вход в личный кабинет", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** While parent login is off, this page does not exist (404), so nothing reveals the feature. */
export default async function ParentLoginPage() {
  if (!parentState().enabled) notFound();
  try {
    if (await currentSession()) redirect("/account");
  } catch (error) {
    // The store is down: the form still shows; verification fails closed with a clear message.
    if (!(error instanceof SessionStoreUnavailable)) throw error;
  }
  return <ParentLoginForm />;
}
