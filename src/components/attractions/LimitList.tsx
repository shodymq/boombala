import type { Attraction } from "@/types";
import { limitItems } from "@/lib/attractions";

/** Age / height / weight facts as a compact label-value list. Unknown limits say "уточняйте у оператора". */
export function LimitList({ attraction, className = "" }: { attraction: Attraction; className?: string }) {
  const items = limitItems(attraction);
  if (items.length === 0) {
    const note = attraction.limits.admissionNote;
    return note ? (
      <p className={`border-l-[3px] border-sun-400 pl-3 text-base font-semibold text-grape-800 ${className}`}>{note}</p>
    ) : null;
  }
  return (
    <dl className={`grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-4 gap-y-3 ${className}`}>
      {items.map((item) => (
        <div key={item.id} className="min-w-0 border-l-[3px] border-sun-400 pl-3">
          <dt className="font-display text-[0.6875rem] font-extrabold uppercase tracking-[0.12em] text-grape-600">
            {item.label}
          </dt>
          <dd
            className={`mt-0.5 font-display font-black leading-tight tracking-tight ${
              item.pending ? "text-base text-muted" : "text-xl text-grape-800"
            }`}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
