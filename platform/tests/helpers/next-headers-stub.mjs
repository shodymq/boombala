export async function headers() {
  return new Headers();
}
export async function cookies() {
  return { get: () => undefined, getAll: () => [], has: () => false };
}
