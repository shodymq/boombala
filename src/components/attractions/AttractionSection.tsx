import type { Attraction } from "@/types";
import { AttractionGallery } from "./AttractionGallery";
import { AttractionRules } from "./AttractionRules";
import { LimitList } from "./LimitList";

/** One attraction on /attractions. Photo dominates; desktop alternates sides. */
export function AttractionSection({ attraction, index }: { attraction: Attraction; index: number }) {
  const flip = index % 2 === 1;
  const first = index === 0;
  const hasPhoto = attraction.images.length > 0;
  return (
    <article
      id={attraction.slug}
      aria-labelledby={`${attraction.slug}-title`}
      className="scroll-mt-24 border-t-[3px] border-grape-800 py-8 md:py-14"
    >
      <div className="grid gap-5 lg:grid-cols-12 lg:items-start lg:gap-12">
        {hasPhoto ? (
          <AttractionGallery
            photos={attraction.images}
            priority={first}
            sizes="(min-width: 1280px) 720px, (min-width: 1024px) 58vw, 100vw"
            className={`lg:col-span-7 ${flip ? "lg:order-2" : ""}`}
          />
        ) : null}

        <div className={`${hasPhoto ? "lg:col-span-5" : "lg:col-span-12"} ${flip ? "lg:order-1" : ""} lg:pt-4`}>
          <h2
            id={`${attraction.slug}-title`}
            className="font-display text-[2.25rem] font-black leading-[0.98] tracking-tighter text-grape-800 sm:text-5xl lg:text-[3.5rem]"
          >
            {attraction.name}
          </h2>
          {attraction.subtitle ? <p className="mt-1 text-base text-muted">{attraction.subtitle}</p> : null}
          {attraction.shortDescription ? (
            <p className="mt-3 max-w-[36ch] text-lg leading-relaxed text-grape-900">{attraction.shortDescription}</p>
          ) : null}

          <LimitList attraction={attraction} className="mt-5" />

          <div className="mt-5">
            <AttractionRules attraction={attraction} />
          </div>
        </div>
      </div>
    </article>
  );
}
