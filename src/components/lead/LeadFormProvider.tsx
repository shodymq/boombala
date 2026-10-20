"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { LeadForm } from "./LeadForm";
import { trackBirthday } from "@/lib/funnel";
import type { LeadPackage } from "@/lib/lead";
import { useSelectedPackage } from "./SelectedPackage";

interface OpenOptions {
  package?: LeadPackage;
  /** Preferred room id (from the room gallery). */
  room?: string;
  /** Where the click came from, for analytics (e.g. "hero", "package-row"). */
  source?: string;
}

interface LeadFormContextValue {
  open: (options?: OpenOptions) => void;
  isOpen: boolean;
}

const LeadFormContext = createContext<LeadFormContextValue | null>(null);

export function useLeadForm(): LeadFormContextValue {
  const ctx = useContext(LeadFormContext);
  if (!ctx) throw new Error("useLeadForm must be used inside <LeadFormProvider>");
  return ctx;
}

export function LeadFormProvider({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState(0); // remount the form on each open
  const [initialPackage, setInitialPackage] = useState<LeadPackage>("undecided");
  const [initialRoom, setInitialRoom] = useState("");
  const { setSelected } = useSelectedPackage();

  const open = useCallback((options: OpenOptions = {}) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInitialPackage(options.package ?? "undecided");
    // Remember the package this visit asked for, so later CTAs (header, sticky bar) open with it.
    if (options.package) setSelected(options.package);
    setInitialRoom(options.room ?? "");
    setSession((n) => n + 1);
    setIsOpen(true);
    trackBirthday("birthday_lead_form_open", {
      package_id: options.package ?? "undecided",
      room_id: options.room ?? "",
      cta_source: options.source ?? "unknown",
    });
  }, [setSelected]);

  // Idempotent: called by our own close buttons and by the native "close" event (Escape).
  const finish = useCallback(() => {
    setIsOpen(false);
    returnFocus.current?.focus?.();
  }, []);

  const close = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    finish();
  }, [finish]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) dialog.showModal();
  }, [isOpen, session]);

  // Scroll lock follows state, so it is always released when the form closes.
  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Escape closes the native dialog without going through close().
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Ignore a late "close" from an earlier session if the dialog has since been reopened.
    const onClose = () => {
      if (!dialog.open) finish();
    };
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, [finish]);

  const value = useMemo(() => ({ open, isOpen }), [open, isOpen]);

  return (
    <LeadFormContext.Provider value={value}>
      {children}
      <Sheet ref={dialogRef} labelledBy="lead-title" onBackdrop={close}>
        {isOpen ? <LeadForm key={session} initialPackage={initialPackage} initialRoom={initialRoom} onClose={close} /> : null}
      </Sheet>
    </LeadFormContext.Provider>
  );
}
