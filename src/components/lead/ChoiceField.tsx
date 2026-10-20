"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CaretDown, Check } from "@phosphor-icons/react";

export interface ChoiceOption {
  value: string;
  label: string;
  /** Small cover (an existing site image, loaded only when the list is open or the option is chosen). */
  image?: { src: string; alt?: string };
}

const fieldBase =
  "flex min-h-12 w-full items-center gap-3 rounded-2xl border-2 bg-white px-4 text-left text-base text-ink transition-colors sm:min-h-14 focus:outline-none focus-visible:border-grape-600";

function Thumb({ src }: { src: string }) {
  return (
    <span className="relative block h-9 w-12 shrink-0 overflow-hidden rounded-lg bg-grape-100">
      <Image src={src} alt="" fill sizes="48px" quality={60} className="object-cover" />
    </span>
  );
}

/**
 * Branded replacement for a native <select>: a compact field that expands an INLINE list of cards (no second modal,
 * no system picker). ARIA listbox pattern: the trigger is a button (haspopup=listbox), the list is focused when it opens,
 * arrows/Home/End move, Enter/Space choose, Escape closes only the list (and leaves the dialog open), Tab leaves it.
 */
export function ChoiceField({
  id,
  value,
  options,
  onChange,
  labelledBy,
  describedBy,
  invalid,
  name,
}: {
  id: string;
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  /** id of the visible <label> */
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  name?: string;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selectedIndex);
  const selected = options[selectedIndex];

  // On open: focus the list and make sure it is visible inside the scrolling form area.
  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
    listRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const openList = () => {
    setActive(selectedIndex);
    setOpen(true);
  };
  const closeList = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const choose = (i: number) => {
    const opt = options[i];
    if (!opt) return;
    onChange(opt.value);
    closeList();
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((i) => (i + 1) % options.length);
    else if (e.key === "ArrowUp") setActive((i) => (i - 1 + options.length) % options.length);
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(options.length - 1);
    else if (e.key === "Enter" || e.key === " ") choose(active);
    else if (e.key === "Escape") closeList();
    else return;
    // Escape must not also close the dialog; the arrows must not scroll the form.
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelledBy} ${id}`}
        aria-describedby={describedBy}
        onClick={() => (open ? closeList(false) : openList())}
        className={`${fieldBase} ${open ? "border-grape-600" : "border-grape-200"} ${invalid ? "border-lava-500" : ""}`}
      >
        {selected?.image ? <Thumb src={selected.image.src} /> : null}
        <span className="min-w-0 flex-1 truncate font-semibold">{selected?.label}</span>
        <CaretDown size={18} weight="bold" aria-hidden="true" className={`shrink-0 text-grape-700 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={labelledBy}
          aria-activedescendant={`${listId}-${active}`}
          onKeyDown={onListKey}
          onBlur={(e) => {
            // focus moved outside the list (Tab, tap elsewhere): collapse without stealing focus back
            if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget !== triggerRef.current) setOpen(false);
          }}
          className="mt-2 grid gap-2 rounded-2xl bg-grape-50 p-2 focus:outline-none"
        >
          {options.map((o, i) => {
            const isSelected = i === selectedIndex;
            return (
              <div
                key={o.value || "none"}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={isSelected}
                data-value={o.value}
                onClick={() => choose(i)}
                className={`flex min-h-14 cursor-pointer select-none items-center gap-3 rounded-xl border-2 px-3 py-2 transition-colors ${
                  isSelected ? "border-grape-700 bg-grape-700 text-white" : "border-transparent bg-white text-grape-900 hover:border-grape-200"
                } ${i === active ? "outline outline-[3px] outline-offset-1 outline-grape-500" : ""}`}
              >
                {o.image ? <Thumb src={o.image.src} /> : null}
                <span className="min-w-0 flex-1 font-display text-base font-extrabold leading-tight">{o.label}</span>
                <span
                  aria-hidden="true"
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
                    isSelected ? "border-sun-400 bg-sun-400 text-grape-900" : "border-grape-200 bg-white"
                  }`}
                >
                  {isSelected ? <Check size={14} weight="bold" /> : null}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
