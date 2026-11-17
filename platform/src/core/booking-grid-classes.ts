/**
 * Minute positions for the day timeline.
 *
 * A Content-Security-Policy forbids inline style attributes (see proxy.ts), so a block cannot be placed with `style={{top}}`.
 * Instead globals.css defines two functional utilities, `bk-top-<minutes>` and `bk-h-<minutes>`, and generates every value
 * from 0 to AXIS_MAX_MINUTES (@source inline). A reservation at 16:40 on a 10:00 axis is therefore `bk-top-400`, exactly, with
 * no rounding to a visual step.
 */
import { AXIS_MAX_MINUTES } from "./booking-calendar.ts";

function whole(minutes: number): number {
  return Math.min(Math.max(Math.round(minutes), 0), AXIS_MAX_MINUTES);
}

export const topClass = (minutes: number): string => `bk-top-${whole(minutes)}`;
export const heightClass = (minutes: number): string => `bk-h-${whole(minutes)}`;

/** Side-by-side lanes for overlapping items (the kernel forbids overlap; the grid still shows it instead of hiding it). */
export const LANE_CLASSES: Record<number, { left: string; width: string }[]> = {
  1: [{ left: "left-1", width: "w-[calc(100%-0.5rem)]" }],
  2: [
    { left: "left-1", width: "w-[calc(50%-0.375rem)]" },
    { left: "left-1/2", width: "w-[calc(50%-0.375rem)]" },
  ],
  3: [
    { left: "left-1", width: "w-[calc(33.333%-0.3rem)]" },
    { left: "left-1/3", width: "w-[calc(33.333%-0.3rem)]" },
    { left: "left-2/3", width: "w-[calc(33.333%-0.3rem)]" },
  ],
};
