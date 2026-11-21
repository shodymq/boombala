// Node loader for the site's TypeScript sources in tests: resolves the project's extensionless imports and the `@/` alias,
// then Node's built-in type stripping runs the files as they are (no build step, no extra dependency).
const SRC = new URL("../src/", import.meta.url);

export async function resolve(specifier, context, next) {
  const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), SRC).href : specifier;
  const relative = target.startsWith("./") || target.startsWith("../") || target.startsWith("file:");
  if (relative && !/\.(ts|tsx|mjs|js|json)$/.test(target)) {
    for (const suffix of [".ts", "/index.ts"]) {
      try {
        return await next(target + suffix, context);
      } catch {
        /* try the next candidate */
      }
    }
  }
  return next(target === specifier ? specifier : target, context);
}
