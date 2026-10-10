import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export default function sitemap(): MetadataRoute.Sitemap {
  const site = getSiteUrl();
  return [
    { url: `${site}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${site}/birthdays`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${site}/attractions`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${site}/menu`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${site}/privacy`, changeFrequency: "yearly", priority: 0.2 },
  ];
}
