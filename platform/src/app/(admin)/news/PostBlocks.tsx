import type { Inline } from "@/core/markup";
import type { PublicBlock } from "@/core/news";

/** Renders parsed blocks as React elements (escaped by React). Used for the admin preview; images come from the admin-only route. */
function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((i, n) =>
        i.t === "text" ? <span key={n}>{i.v}</span>
        : i.t === "strong" ? <strong key={n}>{i.v}</strong>
        : i.t === "br" ? <br key={n} />
        : <a key={n} href={i.href} rel="noopener noreferrer nofollow" className="font-semibold text-grape-700 underline">{i.v}</a>,
      )}
    </>
  );
}

export function PostBlocks({ blocks }: { blocks: PublicBlock[] }) {
  return (
    <div className="grid gap-3 text-base leading-relaxed text-grape-900">
      {blocks.map((b, n) =>
        b.type === "h2" ? <h2 key={n} className="mt-3 text-2xl font-black text-grape-800">{b.text}</h2>
        : b.type === "h3" ? <h3 key={n} className="mt-2 text-xl font-black text-grape-800">{b.text}</h3>
        : b.type === "ul" ? <ul key={n} className="list-disc pl-6">{b.items.map((it, k) => <li key={k}><Inlines items={it} /></li>)}</ul>
        : b.type === "img" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={n} src={`/api/media/${b.imageId}`} alt={b.alt} width={b.width} height={b.height} className="h-auto max-w-full rounded-2xl" />
        ) : <p key={n}><Inlines items={b.inlines} /></p>,
      )}
    </div>
  );
}
