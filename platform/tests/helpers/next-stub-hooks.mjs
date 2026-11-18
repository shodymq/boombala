// Test-only module hook: resolves Next's request-scoped helpers to stubs so server modules that call requestMeta() can run
// outside a Next request (the booking writer reads the client address from the request headers only for the audit record).
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/headers") return { url: new URL("./next-headers-stub.mjs", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
