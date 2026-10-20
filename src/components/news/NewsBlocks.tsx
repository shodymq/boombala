import type { NewsBlock, NewsInline } from "@/lib/platform";

/** The platform sends a block tree, never HTML. Everything below is a React element, so all text is escaped. */
function Inlines({ items }: { items: NewsInline[] }) {
  return (
    <>
      {items.map((i, n) =>
        i.t === "text" ? <span key={n}>{i.v}</span>
        : i.t === "strong" ? <strong key={n}>{i.v}</strong>
        : i.t === "br" ? <br key={n} />
        : (
          <a key={n} href={i.href} {...(/^https?:/i.test(i.href) ? { target: "_blank", rel: "noopener noreferrer nofollow" } : {})} className="font-semibold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2">
            {i.v}
          </a>
        ),
      )}
    </>
  );
}

export function NewsBlocks({ blocks }: { blocks: NewsBlock[] }) {
  return (
    <div className="grid gap-4 text-base leading-relaxed text-grape-900 md:text-lg">
      {blocks.map((b, n) =>
        b.type === "h2" ? <h2 key={n} className="mt-6 font-display text-2xl font-black tracking-tight text-grape-800 md:text-3xl">{b.text}</h2>
        : b.type === "h3" ? <h3 key={n} className="mt-4 font-display text-xl font-black tracking-tight text-grape-800 md:text-2xl">{b.text}</h3>
        : b.type === "ul" ? (
          <ul key={n} className="grid gap-2">
            {b.items.map((it, k) => <li key={k} className="relative pl-5 before:absolute before:left-0 before:top-[0.7em] before:h-2 before:w-2 before:rounded-full before:bg-sun-400"><Inlines items={it} /></li>)}
          </ul>
        ) : b.type === "img" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={n} src={`/news/img/${b.imageId}`} alt={b.alt} width={b.width} height={b.height} loading="lazy" className="h-auto w-full rounded-3xl" />
        ) : <p key={n}><Inlines items={b.inlines} /></p>,
      )}
    </div>
  );
}
