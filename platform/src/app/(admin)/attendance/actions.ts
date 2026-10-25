"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { addManualEntry, confirmRegistrationEntry, correctEntry, REGISTRATION_FILTERS, SEARCH_MAX, SEARCH_PAGE, type RegistrationFilter } from "../../../core/attendance.ts";
import { isValidDate } from "../../../core/dates.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../../../core/errors.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { isHttps } from "../../../server/env.ts";
import { requestMeta } from "../../../server/request.ts";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
/** A whole number typed by a person, or NaN (the core refuses it). */
const num = (f: FormData, k: string) => (/^\d{1,3}$/.test(str(f, k)) ? Number(str(f, k)) : NaN);

function back(date: string, query: string): never {
  redirect(`/attendance?date=${isValidDate(date) ? date : ""}&${query}`);
}

/** Only fixed codes travel in the URL; the page shows fixed texts. */
function failure(date: string, error: unknown): never {
  let code = "failed";
  if (error instanceof ValidationError) code = error.fields.date ? "past" : "invalid";
  else if (error instanceof ConflictError) code = "changed";
  else if (error instanceof NotFoundError) code = "notfound";
  else if (error instanceof ForbiddenError) code = "forbidden";
  return back(date, `error=${code}`);
}

export async function confirmEntryAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("attendance.manage");
  const date = str(formData, "date");
  let duplicate = false;
  let reg = "";
  try {
    const r = await confirmRegistrationEntry(getPool(), { id: user.id, role: user.role }, { registrationId: str(formData, "registrationId"), childrenCount: num(formData, "childrenCount"), onDate: date }, await requestMeta());
    duplicate = r.duplicate;
    reg = `&reg=${r.registrationSeq ?? ""}&cnt=${r.childrenCount}`;
  } catch (error) {
    return failure(date, error);
  }
  return back(date, `notice=${duplicate ? "duplicate" : "confirmed"}${reg}`);
}

export async function manualEntryAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("attendance.manage");
  const date = str(formData, "date");
  let duplicate = false;
  try {
    const r = await addManualEntry(getPool(), { id: user.id, role: user.role }, { childrenCount: num(formData, "childrenCount"), idempotencyKey: str(formData, "idempotencyKey"), onDate: date }, await requestMeta());
    duplicate = r.duplicate;
  } catch (error) {
    return failure(date, error);
  }
  return back(date, `notice=${duplicate ? "duplicate" : "manual"}`);
}

export async function correctEntryAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("attendance.manage");
  const date = str(formData, "date");
  let changed = false;
  try {
    const r = await correctEntry(
      getPool(),
      { id: user.id, role: user.role },
      { entryId: str(formData, "entryId"), newCount: num(formData, "newCount"), expectedCount: num(formData, "expectedCount"), reason: str(formData, "reason") },
      await requestMeta(),
    );
    changed = r.changed;
  } catch (error) {
    return failure(date, error);
  }
  return back(date, `notice=${changed ? "corrected" : "nochange"}`);
}

/**
 * The cashier's search and filter. They are kept in a short-lived cookie of this section and NOT in the address: the address
 * ends up in access logs, a name must not. After confirming an entry the page opens with the same search, ready for the next family.
 */
const COOKIE = "bb_att";
export async function searchAction(formData: FormData): Promise<void> {
  await requirePermission("attendance.manage");
  const date = str(formData, "date");
  const jar = await cookies();
  const filter = str(formData, "f") as RegistrationFilter;
  if (str(formData, "clear") === "1") {
    jar.delete({ name: COOKIE, path: "/attendance" });
  } else {
    const more = Number(str(formData, "n"));
    const value = {
      q: str(formData, "q").slice(0, 60),
      f: REGISTRATION_FILTERS.includes(filter) ? filter : "waiting",
      n: Number.isFinite(more) && more > SEARCH_PAGE ? Math.min(SEARCH_MAX, Math.trunc(more)) : SEARCH_PAGE,
    };
    jar.set(COOKIE, encodeURIComponent(JSON.stringify(value)), { httpOnly: true, secure: isHttps, sameSite: "lax", path: "/attendance", maxAge: 8 * 60 * 60 });
  }
  return back(date, "");
}
