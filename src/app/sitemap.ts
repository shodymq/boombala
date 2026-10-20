import type { MetadataRoute } from "next";
import { fetchNewsSlugs, newsEnabled } from "@/lib/platform";
import { getSiteUrl } from "@/lib/site-url";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const site = getSiteUrl();
  const base: MetadataRoute.Sitemap = [
    { url: `${site}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${site}/birthdays`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${site}/attractions`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${site}/menu`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${site}/privacy`, changeFrequency: "yearly", priority: 0.2 },
  ];
  if (!newsEnabled()) return base;
  // Published news only. If the platform does not answer, the sitemap simply omits them (it never fails or lists drafts).
  try {
    const posts = await fetchNewsSlugs();
    return [
      ...base,
      { url: `${site}/news`, changeFrequency: "weekly", priority: 0.6 },
      ...posts.map((p) => ({ url: `${site}/news/${p.slug}`, lastModified: p.updatedAt, changeFrequency: "monthly" as const, priority: 0.5 })),
    ];
  } catch {
    return base;
  }
}
