import Image from "next/image";
import type { MenuItem } from "@/types";
import { formatTenge } from "@/lib/format";

/** One compact line: name .... price. Photo (optional) becomes a small thumbnail; no photo = no gap. */
export function MenuRow({ item }: { item: MenuItem }) {
  return (
    <li
      data-menu-item={item.id}
      data-price={item.price}
      className="break-inside-avoid border-b border-grape-200/70 py-3.5 last:border-b-0 md:py-3"
    >
      <div className="flex items-start gap-3">
        {item.image ? (
          <Image
            src={item.image}
            alt={item.name}
            width={112}
            height={112}
            sizes="56px"
            className="h-14 w-14 shrink-0 rounded-2xl object-cover"
          />
        ) : null}
        <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto] items-baseline gap-x-4">
          <span className="text-pretty text-[1.0625rem] leading-snug text-ink">{item.name}</span>
          <span className="whitespace-nowrap font-display text-lg font-black tabular-nums text-grape-800">
            {formatTenge(item.price)}
          </span>
          {item.description ? <span className="col-span-2 mt-1 text-sm text-muted">{item.description}</span> : null}
        </div>
      </div>
    </li>
  );
}
