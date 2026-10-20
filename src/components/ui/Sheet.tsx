"use client";

import { forwardRef, type KeyboardEventHandler, type ReactNode } from "react";

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
  return (
    <dialog
      ref={ref}
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
