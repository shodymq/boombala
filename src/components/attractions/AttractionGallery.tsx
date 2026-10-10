"use client";

import Image from "next/image";
import { useState } from "react";
import type { AttractionPhoto } from "@/types";

/** Large photo + small thumbnails (only when there are several photos). No autoplay. */
export function AttractionGallery({
  photos,
  priority = false,
  sizes,
  className = "",
}: {
  photos: AttractionPhoto[];
  priority?: boolean;
  sizes: string;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const main = photos[index] ?? photos[0];
  if (!main) return null;
  const portrait = main.height > main.width;
  const frame = "relative overflow-hidden bg-grape-900";
  const corners = "rounded-tl-[2rem] rounded-br-[2rem] md:rounded-tl-[3rem] md:rounded-br-[3rem]";
  return (
    <div className={className}>
      {/* Desktop, portrait photos: two photos side by side, no switching needed. */}
      {portrait && photos.length > 1 ? (
        <div className="hidden grid-cols-2 gap-4 lg:grid">
          {photos.slice(0, 2).map((p, i) => (
            <div
              key={p.src}
              className={`${frame} ${i === 0 ? "rounded-tl-[3rem] rounded-br-[1rem]" : "rounded-tr-[3rem] rounded-bl-[1rem]"}`}
              style={{ aspectRatio: "4 / 5" }}
            >
              <Image src={p.src} alt={p.alt} fill sizes="(min-width: 1280px) 350px, 28vw" className="object-cover" />
            </div>
          ))}
        </div>
      ) : null}
      <div
        className={`${frame} ${corners} ${portrait && photos.length > 1 ? "lg:hidden" : ""}`}
        style={{ aspectRatio: portrait ? "4 / 5" : "16 / 10" }}
      >
        <Image
          key={main.src}
          src={main.src}
          alt={main.alt}
          fill
          priority={priority}
          sizes={sizes}
          className="object-cover"
        />
      </div>
      {photos.length > 1 ? (
        <ul className={`mt-2 flex gap-2 ${portrait ? "lg:hidden" : ""}`} aria-label="Другие фотографии">
          {photos.map((p, i) => {
            const on = i === index;
            return (
              <li key={p.src}>
                <button
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-label={`Фото ${i + 1} из ${photos.length}`}
                  aria-current={on ? "true" : undefined}
                  className={`relative block h-14 w-[5.5rem] overflow-hidden rounded-xl border-2 transition-colors sm:h-16 sm:w-24 ${
                    on ? "border-grape-700" : "border-transparent opacity-80 hover:opacity-100"
                  }`}
                >
                  <Image src={p.src} alt="" fill sizes="96px" className="object-cover" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
