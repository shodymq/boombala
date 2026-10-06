"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { List, X } from "@phosphor-icons/react";
import { navItems } from "@/lib/nav";

const cta =
  "inline-flex h-11 items-center whitespace-nowrap rounded-full bg-sun-400 px-5 font-display text-[0.9375rem] font-extrabold text-grape-900 shadow-[0_4px_0_0_#b98600] transition-[transform,box-shadow,background-color] duration-150 hover:bg-sun-300 active:translate-y-[2px] active:shadow-[0_2px_0_0_#b98600]";

export function Header() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper">
      <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center justify-between gap-4 px-4 sm:px-6 md:h-[72px] lg:px-10">
        <Link href="/" aria-label="Boom Bala — на главную" className="shrink-0" onClick={() => setOpen(false)}>
          <Image
            src="/brand/logo.webp"
            alt="Boom Bala"
            width={2000}
            height={667}
            priority
            sizes="140px"
            className="h-auto w-[104px] sm:w-[128px] md:w-[140px]"
          />
        </Link>

        <nav aria-label="Основная навигация" className="hidden xl:block">
          <ul className="flex items-center gap-1">
            {navItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="whitespace-nowrap rounded-full px-4 py-2 font-display text-[0.9375rem] font-bold text-grape-800 transition-colors hover:bg-grape-100"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          <Link href="/birthdays" className={cta} onClick={() => setOpen(false)}>
            Дни рождения
          </Link>
          <button
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border-2 border-grape-700 text-grape-700 transition-colors hover:bg-grape-50 xl:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Закрыть меню" : "Открыть меню"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={22} weight="bold" /> : <List size={22} weight="bold" />}
          </button>
        </div>
      </div>

      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Мобильная навигация"
          className="absolute inset-x-0 top-full border-b border-line bg-paper px-4 pb-6 pt-2 shadow-soft xl:hidden"
        >
          <ul className="divide-y divide-line">
            {navItems.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="flex h-14 items-center font-display text-xl font-extrabold text-grape-800"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
