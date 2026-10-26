"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { CaretRight, List, X } from "@phosphor-icons/react";
import { homeLink, infoLinks, isCurrentPage, pageLinks } from "@/lib/nav";
import { useLeadForm } from "@/components/lead/LeadFormProvider";
import { useSelectedPackage } from "@/components/lead/SelectedPackage";
import { useMenuState } from "./MenuState";

const cta =
  "inline-flex h-11 items-center whitespace-nowrap rounded-full bg-sun-400 px-4 font-display text-[0.9375rem] font-extrabold text-grape-900 shadow-[0_4px_0_0_#b98600] transition-[transform,box-shadow,background-color] duration-150 hover:bg-sun-300 active:translate-y-[2px] active:shadow-[0_2px_0_0_#b98600]";

const navLink =
  "relative whitespace-nowrap rounded-full px-2 py-2 font-display text-[0.9375rem] font-bold text-grape-800 transition-colors hover:bg-grape-100";

/** Active page: bolder text and a yellow underline. Anchors never look "active". */
const activeMark = (active: boolean) => (active ? " font-extrabold after:absolute after:inset-x-2 after:-bottom-0.5 after:h-[3px] after:rounded-full after:bg-sun-400" : "");

/** `showParentLogin` is decided on the server (PARENT_LOGIN flag). When false the header is exactly as before. */
export function Header({ showParentLogin = false }: { showParentLogin?: boolean }) {
  const { menuOpen: open, setMenuOpen: setOpen } = useMenuState();
  const pathname = usePathname();
  const { open: openLead } = useLeadForm();
  const { selected, room } = useSelectedPackage();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const closeMenu = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) toggleRef.current?.focus({ preventScroll: true });
    },
    [setOpen],
  );

  // A route change always closes the menu (focus stays wherever the new page puts it).
  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  // While open: lock the page behind, move focus into the menu, handle Escape and Tab.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("a[href], button")?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside: menu button + menu items.
      const items = [toggleRef.current, ...(panelRef.current?.querySelectorAll<HTMLElement>("a[href], button") ?? [])].filter(
        (el): el is HTMLElement => Boolean(el),
      );
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!items.includes(active as HTMLElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, closeMenu]);

  // Widening the window to the desktop layout closes a menu that is no longer shown.
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(min-width: 1080px)");
    const onChange = () => mq.matches && setOpen(false);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [open, setOpen]);

  const book = (source: string) => {
    // Focus goes to the menu button first, so the form returns focus there when it closes.
    toggleRef.current?.focus({ preventScroll: true });
    setOpen(false);
    openLead({ package: selected ?? undefined, room: room || undefined, source });
  };

  const rowClass = (active: boolean) =>
    `flex items-center justify-between gap-3 rounded-2xl px-3.5 py-3 transition-colors ${active ? "bg-grape-100" : "hover:bg-grape-50"}`;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper">
      <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center justify-between gap-4 px-4 sm:px-6 md:h-[72px] lg:px-10">
        <Link
          href="/"
          aria-label="Boom Bala — на главную"
          aria-current={pathname === "/" ? "page" : undefined}
          className="shrink-0"
          onClick={() => open && closeMenu(false)}
        >
          <Image
            src="/brand/logo.webp"
            alt="Boom Bala"
            width={2000}
            height={667}
            priority
            sizes="140px"
            className="h-auto w-[104px] sm:w-[128px] md:w-[140px] min-[1080px]:w-[120px] min-[1440px]:w-[140px]"
          />
        </Link>

        {/* From 1080 px: pages first, then the home-page sections. Абонемент and Вопросы join from 1280 px. */}
        <nav aria-label="Основная навигация" className="hidden min-[1080px]:block">
          <ul className="flex items-center gap-0.5 xl:gap-0.5">
            {pageLinks.map((item) => {
              const active = isCurrentPage(item.href, pathname);
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={active ? "page" : undefined} className={navLink + activeMark(active)}>
                    {item.label}
                  </Link>
                </li>
              );
            })}
            {infoLinks.map((item) => (
              <li key={item.href} className={item.primary ? undefined : "hidden xl:block"}>
                <Link href={item.href} className={navLink}>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-2">
          {showParentLogin ? (
            <Link href="/account" className={`${navLink} max-[1079px]:hidden`}>
              Войти
            </Link>
          ) : null}
          <button type="button" className={`${cta} max-[1079px]:hidden`} onClick={() => book("header")}>
            Забронировать праздник
          </button>
          <button
            ref={toggleRef}
            type="button"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border-2 border-grape-700 text-grape-700 transition-colors hover:bg-grape-50 min-[1080px]:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Закрыть меню" : "Открыть меню"}
            onClick={() => (open ? closeMenu() : setOpen(true))}
          >
            {open ? <X size={22} weight="bold" aria-hidden="true" /> : <List size={22} weight="bold" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {open ? (
        <>
          {/* Backdrop: a tap outside the menu closes it. Not focusable, the menu button and Escape do the same. */}
          <div aria-hidden="true" className="fixed inset-x-0 bottom-0 top-16 z-[-1] bg-grape-900/55 md:top-[72px] min-[1080px]:hidden" onClick={() => closeMenu()} />
          <nav
            ref={panelRef}
            id="mobile-nav"
            aria-label="Мобильная навигация"
            className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain border-b border-line bg-paper px-2 pb-4 pt-1.5 shadow-soft md:left-auto md:right-6 md:max-h-[calc(100dvh-5.5rem)] md:w-[26rem] md:rounded-b-3xl md:border-x min-[1080px]:hidden"
          >
            <Link
              href={homeLink.href}
              aria-current={isCurrentPage(homeLink.href, pathname) ? "page" : undefined}
              onClick={() => closeMenu(false)}
              className={rowClass(isCurrentPage(homeLink.href, pathname))}
            >
              <span>
                <span className="block font-display text-xl font-extrabold leading-tight text-grape-800">{homeLink.label}</span>
                <span className="mt-0.5 block text-sm leading-snug text-muted">{homeLink.hint}</span>
              </span>
            </Link>

            <p className="mx-3.5 mb-1 mt-3 font-display text-xs font-extrabold uppercase tracking-[0.14em] text-grape-600">Разделы</p>
            <ul>
              {pageLinks.map((item) => {
                const active = isCurrentPage(item.href, pathname);
                return (
                  <li key={item.href}>
                    <Link href={item.href} aria-current={active ? "page" : undefined} onClick={() => closeMenu(false)} className={rowClass(active)}>
                      <span>
                        <span className="block font-display text-xl font-extrabold leading-tight text-grape-800">{item.label}</span>
                        <span className="mt-0.5 block text-sm leading-snug text-muted">{item.hint}</span>
                      </span>
                      {active ? null : <CaretRight size={18} weight="bold" aria-hidden="true" className="shrink-0 text-grape-500" />}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <p className="mx-3.5 mb-2 mt-3 font-display text-xs font-extrabold uppercase tracking-[0.14em] text-grape-600">Быстро найти</p>
            <ul className="grid grid-cols-2 gap-2 px-1.5">
              {showParentLogin ? (
                <li>
                  <Link
                    href="/account"
                    onClick={() => closeMenu(false)}
                    className="flex min-h-12 items-center rounded-full border border-line bg-grape-50 px-4 font-display text-base font-extrabold leading-tight text-grape-800 transition-colors hover:bg-grape-100"
                  >
                    Войти
                  </Link>
                </li>
              ) : null}
              {infoLinks.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => closeMenu(false)}
                    className="flex min-h-12 items-center rounded-full border border-line bg-grape-50 px-4 font-display text-base font-extrabold leading-tight text-grape-800 transition-colors hover:bg-grape-100"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>

            <div className="px-1.5 pt-4">
              <button
                type="button"
                onClick={() => book("mobile-menu")}
                className="flex h-14 w-full items-center justify-center rounded-full bg-sun-400 font-display text-base font-extrabold text-grape-900 shadow-[0_5px_0_0_#b98600] transition-[transform,box-shadow] duration-150 active:translate-y-[3px] active:shadow-[0_2px_0_0_#b98600]"
              >
                Забронировать праздник
              </button>
            </div>
          </nav>
        </>
      ) : null}
    </header>
  );
}
