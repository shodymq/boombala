import { siteConfig } from "./config";

/**
 * Resolve data from the shared backend when `apiBaseUrl` is configured,
 * otherwise (or on any failure) fall back to local data.
 * UI never sees where the data came from.
 *
 * NOTE: when the real REST contract lands, map the response to our domain
 * types here (or in the calling service) rather than in components.
 */
export async function resolve<T>(path: string, local: () => T): Promise<T> {
  const base = siteConfig.apiBaseUrl;
  if (!base) return local();
  try {
    const res = await fetch(`${base}${path}`, { next: { revalidate: 300 } });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  } catch {
    return local();
  }
}
