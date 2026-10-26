import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ParentLoginForm } from "@/components/parent/ParentLoginForm";
import { currentSession, parentState } from "@/lib/parent/server";

export const metadata: Metadata = { title: "Вход в личный кабинет", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** While parent login is off, this page does not exist (404), so nothing reveals the feature. */
export default async function ParentLoginPage() {
  if (!parentState().enabled) notFound();
  if (await currentSession()) redirect("/account");
  return <ParentLoginForm />;
}
