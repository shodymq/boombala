import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Queryable } from "./db.ts";

/**
 * Deployment order (mandatory):  1. migrations 001..015  ->  2. database roles (`npm run db:roles`)  ->  3. verification
 * (`npm run preflight`)  ->  4. start the applications.
 * Recreating a function in a migration drops the EXECUTE grant of the API role, so the roles step must follow every migration run.
 * Problems are CODES (no value of the environment, no data): a person fixes them, the application never guesses.
 */

export const REQUIRED_MIGRATION = "013_attendance.sql";
/** Pricing V3 birthday packages: the three ids the site offers (active and priced), and the retired ids that must not be on sale (015). */
export const BIRTHDAY_PACKAGES_V3 = ["happy-party", "star-party", "boom-bala-party"] as const;
export const RETIRED_BIRTHDAY_PACKAGES = ["wow-party", "magic-party", "boom-party"] as const;

/** Cheap check used by the pages that depend on migration 013: true only when everything they read exists. */
export async function attendanceSchemaReady(db: Queryable): Promise<boolean> {
  try {
    const r = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM bb.schema_migrations WHERE name = $1)
          AND to_regclass('bb.attendance_entries') IS NOT NULL
          AND to_regclass('bb.attendance_corrections') IS NOT NULL
          AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'bb' AND table_name = 'consent_registrations' AND column_name = 'children_count') AS ok`,
      [REQUIRED_MIGRATION],
    );
    return r.rows[0]?.ok === true;
  } catch {
    return false;
  }
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
}

/**
 * Full verification of a database before the applications start. `migrationsDir` lets it compare every migration file with
 * what was applied (names, order, checksums, nothing missing, nothing extra). Roles are checked only when they exist.
 */
export async function preflight(db: Queryable, migrationsDir?: string, phase: "ready" | "final" = "ready"): Promise<PreflightResult> {
  try {
    return await runPreflight(db, migrationsDir, phase);
  } catch (error) {
    return { ok: false, problems: [`preflight_failed: ${(error as { code?: string }).code ?? "database error"}`] };
  }
}

/**
 * "ready": the database can take the NEW site: migrations, roles, and the three Pricing V3 packages are active and priced. The retired
 * packages may still be on sale (the live site still offers them until the switch). "final": after the switch, the retired packages
 * must be off sale as well.
 */
async function runPreflight(db: Queryable, migrationsDir: string | undefined, phase: "ready" | "final"): Promise<PreflightResult> {
  const problems: string[] = [];
  const has = async (sql: string, params: unknown[] = []) => (await db.query<{ v: boolean }>(`SELECT (${sql}) AS v`, params)).rows[0].v === true;

  if (!(await has("to_regclass('bb.schema_migrations') IS NOT NULL"))) return { ok: false, problems: ["schema_migrations_missing: run the migrations"] };
  const applied = (await db.query<{ name: string; checksum: string }>("SELECT name, checksum FROM bb.schema_migrations ORDER BY name")).rows;
  if (migrationsDir) {
    const files = (await readdir(migrationsDir)).filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f)).sort();
    const byName = new Map(applied.map((a) => [a.name, a.checksum]));
    for (const f of files) {
      const known = byName.get(f);
      if (!known) problems.push(`migration_missing: ${f}`);
      else if (known !== createHash("sha256").update(await readFile(join(migrationsDir, f), "utf8")).digest("hex")) problems.push(`migration_changed_after_apply: ${f}`);
    }
    for (const a of applied) if (!files.includes(a.name)) problems.push(`migration_unknown_to_this_version: ${a.name}`);
  } else if (!applied.some((a) => a.name === REQUIRED_MIGRATION)) {
    problems.push(`migration_missing: ${REQUIRED_MIGRATION}`);
  }

  if (!(await attendanceSchemaReady(db))) problems.push("attendance_schema_missing: apply migration 013");
  // Pricing V3: the three new packages must be active and priced (015 + `npm run db:seed`); the retired ones must not be on sale.
  const v3 = await db.query<{ id: string; price: number | null; weekday: number | null; is_active: boolean }>(
    `SELECT p.id, p.is_active,
            (SELECT amount_kzt FROM bb.price_rules r WHERE r.package_id = p.id AND r.rule_type = 'base' ORDER BY r.id DESC LIMIT 1) AS price,
            (SELECT amount_kzt FROM bb.price_rules r WHERE r.package_id = p.id AND r.rule_type = 'weekday' ORDER BY r.id DESC LIMIT 1) AS weekday
       FROM bb.packages p WHERE p.id = ANY($1::text[])`,
    [[...BIRTHDAY_PACKAGES_V3]],
  );
  const ready = new Set(v3.rows.filter((r) => r.is_active && r.price !== null && r.weekday !== null).map((r) => r.id));
  if (BIRTHDAY_PACKAGES_V3.some((id) => !ready.has(id))) problems.push("birthday_packages_v3_missing: run npm run db:seed (the three Pricing V3 packages must be active and priced)");
  const onSale = await db.query<{ id: string }>("SELECT id FROM bb.packages WHERE id = ANY($1::text[]) AND is_active", [[...RETIRED_BIRTHDAY_PACKAGES]]);
  if (phase === "final" && onSale.rows.length > 0) problems.push("retired_birthday_package_on_sale: run npm run catalog:retire-legacy after the site switch");
  const fnArgs = (await db.query<{ args: string }>("SELECT pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname = 'intake_insert_registration'")).rows.map((r) => r.args);
  if (!fnArgs.some((a) => /smallint/.test(a))) problems.push("intake_insert_registration_without_children_count_missing");
  if (fnArgs.some((a) => !/smallint/.test(a))) problems.push("old_intake_insert_registration_still_exists");

  const roleExists = async (r: string) => has("EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)", [r]);
  if (await roleExists("bb_api")) {
    const fn = "(SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'bb' AND p.proname = 'intake_insert_registration' AND pg_get_function_identity_arguments(p.oid) ~ 'smallint' LIMIT 1)";
    if (!(await has(`has_function_privilege('bb_api', ${fn}, 'EXECUTE')`))) problems.push("bb_api_cannot_execute_intake_insert_registration: run db:roles after the migrations");
    for (const t of ["attendance_entries", "attendance_corrections", "consent_registrations"]) {
      if (await has(`to_regclass('bb.${t}') IS NOT NULL AND has_table_privilege('bb_api', 'bb.${t}', 'SELECT,INSERT,UPDATE,DELETE')`)) problems.push(`bb_api_has_table_privilege: ${t}`);
    }
  }
  if (await roleExists("bb_admin")) {
    for (const t of ["attendance_entries", "attendance_corrections"]) {
      if (!(await has(`to_regclass('bb.${t}') IS NOT NULL`))) continue; // already reported as attendance_schema_missing
      if (!(await has(`has_table_privilege('bb_admin', 'bb.${t}', 'SELECT') AND has_table_privilege('bb_admin', 'bb.${t}', 'INSERT')`))) problems.push(`bb_admin_lacks_privilege: ${t}: run db:roles after the migrations`);
      if (await has(`has_table_privilege('bb_admin', 'bb.${t}', 'DELETE') OR has_table_privilege('bb_admin', 'bb.${t}', 'TRUNCATE')`)) problems.push(`bb_admin_may_delete: ${t}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
