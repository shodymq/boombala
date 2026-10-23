// Shared by db:export and db:restore (no side effects on import).
export const FORMAT = "bb-export-1";

/** TLS for a connection string: local hosts none; remote needs a CA (DATABASE_CA_CERT) or a conscious DATABASE_SSL=no-verify. */
export function sslFor(connectionString, env = process.env) {
  const host = new URL(connectionString).hostname;
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return false;
  if (env.DATABASE_CA_CERT) return { ca: env.DATABASE_CA_CERT.replace(/\\n/g, "\n"), rejectUnauthorized: true };
  if (env.DATABASE_SSL === "no-verify") return { rejectUnauthorized: false };
  throw new Error("remote database without a CA: set DATABASE_CA_CERT or DATABASE_SSL=no-verify");
}

/** Row count and a content hash of one table, computed by the database (the session must use TIME ZONE 'UTC'). */
export const rowHashSql = (t) => `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM bb.${t} x`;
