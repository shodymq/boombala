import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";

export default function robots(): MetadataRoute.Robots {
  const site = getSiteUrl();
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${site}/sitemap.xml`,
    host: site,
  };
}
