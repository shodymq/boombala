import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container } from "@/components/ui/Container";
import { NewsBlocks } from "@/components/news/NewsBlocks";
import { fetchNewsPost, newsEnabled, type NewsPost } from "@/lib/platform";
import { getSiteUrl } from "@/lib/site-url";

export const revalidate = 60;

type Params = { params: Promise<{ slug: string }> };
const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Almaty" });

/** `null` = no such published post. A platform outage throws and is shown by the error boundary, never as a 404. */
async function load(slug: string): Promise<NewsPost | null> {
  if (!newsEnabled()) return null;
  return fetchNewsPost(slug);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  let post: NewsPost | null = null;
  try {
    post = await load(slug);
  } catch {
    return { title: "Новости", robots: { index: false } };
  }
  if (!post) return { title: "Страница не найдена", robots: { index: false, follow: false } };
  const title = post.seoTitle || post.title;
  const image = post.cover ? [{ url: `/news/img/${post.cover.id}`, width: post.cover.width, height: post.cover.height, alt: post.cover.alt }] : ["/opengraph-image"];
  return {
    title,
    description: post.seoDescription,
    alternates: { canonical: `/news/${post.slug}` },
    openGraph: { title: `${title} — Boom Bala`, description: post.seoDescription, url: `/news/${post.slug}`, locale: "ru_RU", type: "article", publishedTime: post.publishedAt, modifiedTime: post.updatedAt, images: image },
    twitter: { card: "summary_large_image", title: `${title} — Boom Bala`, description: post.seoDescription, images: post.cover ? [`/news/img/${post.cover.id}`] : ["/opengraph-image"] },
  };
}

export default async function NewsPostPage({ params }: Params) {
  const { slug } = await params;
  const post = await load(slug);
  if (!post) notFound();
  const site = getSiteUrl();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: post.title,
    description: post.seoDescription,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    mainEntityOfPage: `${site}/news/${post.slug}`,
    ...(post.cover ? { image: [`${site}/news/img/${post.cover.id}`] } : {}),
    publisher: { "@type": "Organization", name: "Boom Bala", url: site },
  };
  return (
    <article aria-labelledby="post-title" className="py-12 md:py-20">
      <Container>
        <div className="mx-auto max-w-3xl">
          <Link href="/news" className="text-sm font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4">← Новости и акции</Link>
          <p className="mt-6 text-xs font-extrabold uppercase tracking-[0.12em] text-grape-600">
            {post.kind === "promo" ? "Акция" : "Новость"} · {dateFmt.format(new Date(post.publishedAt))}
          </p>
          <h1 id="post-title" className="mt-2 font-display text-[1.85rem] font-black leading-[1.1] tracking-tight text-grape-800 [overflow-wrap:anywhere] sm:text-5xl">{post.title}</h1>
          {post.kind === "promo" && post.validUntil ? (
            <p className={`mt-3 text-base font-bold ${post.expired ? "text-[#b3261e]" : "text-grape-700"}`}>
              {post.expired ? "Акция завершена" : `Действует до ${dateFmt.format(new Date(`${post.validUntil}T00:00:00+05:00`))}`}
            </p>
          ) : null}
          {post.cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/news/img/${post.cover.id}`} alt={post.cover.alt} width={post.cover.width} height={post.cover.height} className="mt-6 h-auto w-full rounded-3xl" />
          ) : null}
          <div className="mt-6"><NewsBlocks blocks={post.blocks} /></div>
        </div>
      </Container>
      {/* "<" is escaped so no field of the article can close the script element */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
    </article>
  );
}
