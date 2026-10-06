"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { LeadPackage } from "@/lib/lead";

interface Ctx {
  /** Package currently chosen in the mobile package selector; `null` when none has been shown/picked yet. */
  selected: LeadPackage | null;
  setSelected: (pkg: LeadPackage) => void;
}

const SelectedPackageContext = createContext<Ctx>({ selected: null, setSelected: () => {} });

export const useSelectedPackage = () => useContext(SelectedPackageContext);

/** Shares the package picked in the mobile selector with the sticky booking bar (and thus the lead form). */
export function SelectedPackageProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<LeadPackage | null>(null);
  const value = useMemo(() => ({ selected, setSelected }), [selected]);
  return <SelectedPackageContext.Provider value={value}>{children}</SelectedPackageContext.Provider>;
}
