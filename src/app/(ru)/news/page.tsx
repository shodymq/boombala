import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Container } from "@/components/ui/Container";
import { fetchNewsList, newsEnabled, type NewsSummary } from "@/lib/platform";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Новости и акции",
  description: "Новости и акции детского развлекательного центра Boom Bala в Алматы.",
  alternates: { canonical: "/news" },
  openGraph: { title: "Новости и акции — Boom Bala", description: "Новости и акции Boom Bala.", url: "/news", locale: "ru_RU", type: "website", images: ["/opengraph-image"] },
};

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Almaty" });

function Card({ post }: { post: NewsSummary }) {
  return (
    <li>
      <Link href={`/news/${post.slug}`} className="grid h-full overflow-hidden rounded-3xl border border-grape-100 bg-white transition-colors hover:border-grape-400">
        {post.cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/news/img/${post.cover.id}`} alt={post.cover.alt} width={post.cover.width} height={post.cover.height} loading="lazy" className="aspect-[16/9] w-full object-cover" />
        ) : null}
        <div className="p-5">
          <p className="text-xs font-extrabold uppercase tracking-[0.12em] text-grape-600">
            {post.kind === "promo" ? "Акция" : "Новость"} · {dateFmt.format(new Date(post.publishedAt))}
          </p>
          <h3 className="mt-2 font-display text-xl font-black leading-tight text-grape-800 [overflow-wrap:anywhere]">{post.title}</h3>
          {post.excerpt ? <p className="mt-2 text-base text-grape-900">{post.excerpt}</p> : null}
          {post.validUntil ? <p className="mt-2 text-sm font-bold text-grape-700">Действует до {dateFmt.format(new Date(`${post.validUntil}T00:00:00+05:00`))}</p> : null}
        </div>
      </Link>
    </li>
  );
}

export default async function NewsPage() {
  if (!newsEnabled()) notFound();
  let posts: NewsSummary[] | null = null;
  try {
    posts = await fetchNewsList();
  } catch {
    posts = null; // the platform did not answer: say so, do not pretend there is no news
  }
  const promos = posts?.filter((p) => p.kind === "promo") ?? [];
  const news = posts?.filter((p) => p.kind === "news") ?? [];
  return (
    <section aria-labelledby="news-title" className="py-12 md:py-20">
      <Container>
        <h1 id="news-title" className="font-display text-[1.85rem] font-black leading-[1.1] tracking-tight text-grape-800 sm:text-5xl">Новости и акции</h1>
        {posts === null ? (
          <p role="status" className="mt-6 text-lg text-grape-900">Раздел временно недоступен. Загляните позже.</p>
        ) : posts.length === 0 ? (
          <p className="mt-6 text-lg text-grape-900">Пока здесь пусто. Следите за обновлениями.</p>
        ) : (
          <>
            {promos.length ? (
              <>
                <h2 className="mt-10 font-display text-2xl font-black text-grape-800">Акции</h2>
                <ul className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{promos.map((p) => <Card key={p.slug} post={p} />)}</ul>
              </>
            ) : null}
            {news.length ? (
              <>
                <h2 className="mt-10 font-display text-2xl font-black text-grape-800">Новости</h2>
                <ul className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{news.map((p) => <Card key={p.slug} post={p} />)}</ul>
              </>
            ) : null}
          </>
        )}
      </Container>
    </section>
  );
}
