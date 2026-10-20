"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ConflictError, ForbiddenError, ValidationError } from "../../../core/errors.ts";
import { approveDocument, createDraft, LEGAL_KINDS, publishDocument, retireDocument, updateDraft, type LegalKind } from "../../../core/legal.ts";
import { requirePermission } from "../../../server/dal.ts";
import { getPool } from "../../../server/db.ts";
import { requestMeta } from "../../../server/request.ts";

const uuid = z.string().uuid();

function failure(error: unknown): never {
  let code = "failed";
  if (error instanceof ValidationError) code = Object.keys(error.fields).includes("body") ? "placeholders" : "invalid";
  else if (error instanceof ConflictError) code = "conflict";
  else if (error instanceof ForbiddenError) code = "forbidden";
  redirect(`/legal?error=${code}`);
}

async function run(formData: FormData, fn: (actor: { id: string; role: "owner" | "manager" | "editor" }, id: string, meta: Awaited<ReturnType<typeof requestMeta>>) => Promise<unknown>, notice: string) {
  const { user } = await requirePermission("legal.manage");
  const id = uuid.safeParse(formData.get("id"));
  if (!id.success) return failure(new ValidationError({ id: "bad" }));
  try {
    await fn({ id: user.id, role: user.role }, id.data, await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect(`/legal?notice=${notice}`);
}

export async function createDraftAction(formData: FormData): Promise<void> {
  const { user } = await requirePermission("legal.manage");
  const kind = String(formData.get("kind") ?? "");
  if (!(LEGAL_KINDS as readonly string[]).includes(kind)) return failure(new ValidationError({ kind: "bad" }));
  try {
    await createDraft(getPool(), { id: user.id, role: user.role }, { kind: kind as LegalKind, title: String(formData.get("title") ?? ""), body: String(formData.get("body") ?? "") }, await requestMeta());
  } catch (error) {
    return failure(error);
  }
  redirect("/legal?notice=created");
}

export const updateDraftAction = async (f: FormData) => run(f, (a, id, m) => updateDraft(getPool(), a, id, { title: String(f.get("title") ?? ""), body: String(f.get("body") ?? "") }, m), "saved");
export const approveAction = async (f: FormData) => run(f, (a, id, m) => approveDocument(getPool(), a, id, m), "approved");
export const publishAction = async (f: FormData) => run(f, (a, id, m) => publishDocument(getPool(), a, id, m), "published");
export const retireAction = async (f: FormData) => run(f, (a, id, m) => retireDocument(getPool(), a, id, m), "retired");
