"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEventHandler, type ReactNode } from "react";

/**
 * Native <dialog> used as a bottom sheet (phones) / centred dialog (>= 640px). Structure that callers fill in:
 *   <header shrink-0> + <scroll area flex-1 overflow-y-auto> + <actions shrink-0>
 * Only the scroll area moves; header and actions stay put. The panel is a fixed-gap flex column (see globals.css), so there is no
 * sticky positioning, no dvh and no media-query flip that could move things while the browser chrome or the keyboard changes the screen.
 * Backdrop click and Escape are handled by the caller (they close through the same function as the close button).
 */
export const Sheet = forwardRef<
  HTMLDialogElement,
  { labelledBy: string; onBackdrop: () => void; onKeyDown?: KeyboardEventHandler<HTMLDialogElement>; wide?: boolean; children: ReactNode }
>(function Sheet({ labelledBy, onBackdrop, onKeyDown, wide, children }, ref) {
  const local = useRef<HTMLDialogElement>(null);
  useImperativeHandle(ref, () => local.current as HTMLDialogElement);

  // iOS Safari does not resize the layout viewport when the on-screen keyboard opens: it shrinks (and may pan) the VISUAL viewport,
  // so a fixed bottom sheet would keep its buttons under the keyboard, or its title above the panned screen (measured in the iOS 26
  // Simulator). While the keyboard is up, make the sheet's container exactly as big as the visual viewport and mark it compact
  // (secondary actions fold away). Without a keyboard nothing is set. Android Chrome resizes the layout itself
  // (interactive-widget=resizes-content), so the visual viewport equals the layout viewport there and nothing happens either.
  useEffect(() => {
    const vv = window.visualViewport;
    const d = local.current;
    if (!vv || !d) return;
    const clear = () => {
      d.style.top = "";
      d.style.bottom = "";
      d.style.height = "";
      d.removeAttribute("data-kb");
    };
    const update = () => {
      const keyboard = d.open && vv.height < window.innerHeight - 80;
      if (!keyboard) return clear();
      d.style.top = `${Math.round(vv.offsetTop)}px`;
      d.style.bottom = "auto";
      d.style.height = `${Math.round(vv.height)}px`;
      d.setAttribute("data-kb", "");
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    d.addEventListener("close", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      d.removeEventListener("close", update);
      clear();
    };
  }, []);

  return (
    <dialog
      ref={local}
      className="sheet"
      aria-labelledby={labelledBy}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // only a click on the dim area itself (not on the panel) closes
        if (e.target === e.currentTarget) onBackdrop();
      }}
    >
      <div className="sheet-panel" data-wide={wide ? "" : undefined}>
        {children}
      </div>
    </dialog>
  );
});
