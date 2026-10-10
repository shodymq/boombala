"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { LeadPackage } from "@/lib/lead";

interface Ctx {
  /** Package currently chosen in the mobile package selector; `null` when none has been shown/picked yet. */
  selected: LeadPackage | null;
  setSelected: (pkg: LeadPackage) => void;
  /** Room id the visitor has chosen during this visit ("" when none). Kept in memory only, never persisted. */
  room: string;
  setRoom: (roomId: string) => void;
}

const SelectedPackageContext = createContext<Ctx>({ selected: null, setSelected: () => {}, room: "", setRoom: () => {} });

export const useSelectedPackage = () => useContext(SelectedPackageContext);

/**
 * Shares what the visitor picked in this visit (package from the mobile selector, preferred room from the
 * room dialog or the form) with the sticky booking bar, so the lead form opens with it. React state only:
 * a reload starts clean.
 */
export function SelectedPackageProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<LeadPackage | null>(null);
  const [room, setRoom] = useState("");
  const value = useMemo(() => ({ selected, setSelected, room, setRoom }), [selected, room]);
  return <SelectedPackageContext.Provider value={value}>{children}</SelectedPackageContext.Provider>;
}
