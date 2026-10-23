import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPool } from "../src/core/db.ts";
import { approveDocument, createDraft, hasPlaceholders, LEGAL_KINDS, publishDocument, type LegalKind } from "../src/core/legal.ts";
import { isRole } from "../src/core/rbac.ts";

// Loads OWNER-APPROVED legal texts (markdown files named after the kind, e.g. visit_rules.md or visit-rules.md) into the platform.
//   DATABASE_URL=… OWNER_EMAIL=… npm run legal:load -- --dir /path/to/approved            dry run: shows what would happen, writes nothing
//   DATABASE_URL=… OWNER_EMAIL=… npm run legal:load -- --dir /path/to/approved --publish  creates, approves and publishes (the Owner's act)
// The first line `# Title` is the title, the rest is the text. A text with any `[ТРЕБУЕТСЯ …]` mark is refused (the database refuses it too).
// Publishing is done AS the Owner (approved_by / published_by in the audit log); run it only after the Owner has confirmed the final texts.
// The QR registration needs visit_rules and personal_data_consent; companion_duties is shown when published.
const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const dir = arg("dir");
const publish = args.includes("--publish");
const url = process.env.DATABASE_URL;
const ownerEmail = (process.env.OWNER_EMAIL ?? "").trim().toLowerCase();
if (!dir || !url || !ownerEmail) {
  console.error("usage: DATABASE_URL=… OWNER_EMAIL=… npm run legal:load -- --dir <folder> [--publish]");
  process.exit(2);
}
const pool = createPool(url, { max: 1 });
try {
  const owner = (await pool.query<{ id: string; role: string }>("SELECT id, role::text AS role FROM bb.users WHERE lower(email) = $1 AND is_active", [ownerEmail])).rows[0];
  if (!owner || owner.role !== "owner" || !isRole(owner.role)) throw new Error("OWNER_EMAIL is not an active Owner");
  const actor = { id: owner.id, role: "owner" as const };
  const files = readdirSync(resolve(dir)).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
  const plan: Array<{ kind: LegalKind; title: string; body: string; file: string }> = [];
  const problems: string[] = [];
  for (const f of files) {
    const kind = f.replace(/\.md$/, "").replace(/-/g, "_") as LegalKind;
    if (!(LEGAL_KINDS as readonly string[]).includes(kind)) {
      problems.push(`${f}: not a known kind`);
      continue;
    }
    const text = readFileSync(join(resolve(dir), f), "utf8").trim();
    const m = /^#\s+(.+)\n+([\s\S]*)$/.exec(text);
    if (!m) {
      problems.push(`${f}: the first line must be "# Title" followed by the text`);
      continue;
    }
    if (hasPlaceholders(m[2]) || hasPlaceholders(m[1])) {
      problems.push(`${f}: still has [ТРЕБУЕТСЯ …] marks`);
      continue;
    }
    plan.push({ kind, title: m[1].trim(), body: m[2].trim() + "\n", file: f });
  }
  const kinds = new Set(plan.map((p) => p.kind));
  const published = new Set((await pool.query<{ kind: string }>("SELECT kind::text AS kind FROM bb.legal_documents WHERE status = 'published'")).rows.map((r) => r.kind));
  for (const need of ["visit_rules", "personal_data_consent"]) if (!kinds.has(need as LegalKind) && !published.has(need)) problems.push(`${need}: required for the QR registration and neither provided nor published`);
  console.log(`plan: ${plan.map((p) => p.kind).join(", ") || "nothing"}`);
  for (const p of problems) console.log(`  problem: ${p}`);
  if (problems.length) process.exitCode = 1;
  else if (!publish) console.log("dry run: nothing written (add --publish to create, approve and publish as the Owner)");
  else {
    for (const p of plan) {
      const d = await createDraft(pool, actor, { kind: p.kind, title: p.title, body: p.body });
      await approveDocument(pool, actor, d.id);
      await publishDocument(pool, actor, d.id);
      console.log(`  published ${p.kind} edition ${d.version}`);
    }
  }
} finally {
  await pool.end();
}
