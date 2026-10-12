"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface Ctx {
  /** The mobile menu is open: other floating UI (the sticky booking bar) steps aside. */
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

const MenuStateContext = createContext<Ctx>({ menuOpen: false, setMenuOpen: () => {} });

export const useMenuState = () => useContext(MenuStateContext);

export function MenuStateProvider({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const value = useMemo(() => ({ menuOpen, setMenuOpen }), [menuOpen]);
  return <MenuStateContext.Provider value={value}>{children}</MenuStateContext.Provider>;
}
