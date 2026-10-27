"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { completeMfaLogin } from "../../../core/auth.ts";
import { redeemEnrollmentCode } from "../../../core/enrollment.ts";
import { getPool } from "../../../server/db.ts";
import { SESSION_COOKIE, isHttps, mfaKey } from "../../../server/env.ts";
import { requestMeta } from "../../../server/request.ts";

export interface MfaState {
  error?: string;
  /** Shown once, right after enrolment. The session is already complete; the person continues from the page. */
  recoveryCodes?: string[];
}

const schema = z.object({ code: z.string().trim().min(5).max(40) });

export async function submitSecondFactor(_prev: MfaState | undefined, formData: FormData): Promise<MfaState> {
  const parsed = schema.safeParse({ code: formData.get("code") });
  if (!parsed.success) return { error: "Введите код из приложения." };
  const jar = await cookies();
  const meta = await requestMeta();
  const result = await completeMfaLogin(getPool(), {
    pendingToken: jar.get(SESSION_COOKIE)?.value,
    code: parsed.data.code,
    mfaKey,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (!result.ok) {
    if (result.reason === "expired") redirect("/login");
    if (result.reason === "locked") return { error: `Слишком много неудачных попыток. Повторите через ${Math.max(1, Math.ceil(result.retryAfterSeconds / 60))} мин.` };
    return { error: "Неверный код." };
  }
  jar.set(SESSION_COOKIE, result.token, { httpOnly: true, secure: isHttps, sameSite: "lax", path: "/", expires: result.expiresAt });
  if (result.recoveryCodes) return { recoveryCodes: result.recoveryCodes };
  redirect("/");
}

const codeSchema = z.object({ code: z.string().trim().min(8).max(24) });

/** The new employee types the one-time code the Owner handed over. Only then does the page show the authenticator secret. */
export async function redeemEnrollmentAction(_prev: MfaState | undefined, formData: FormData): Promise<MfaState> {
  const parsed = codeSchema.safeParse({ code: formData.get("code") });
  if (!parsed.success) return { error: "Введите код настройки от владельца." };
  const jar = await cookies();
  const meta = await requestMeta();
  const r = await redeemEnrollmentCode(getPool(), { pendingToken: jar.get(SESSION_COOKIE)?.value, code: parsed.data.code, ip: meta.ip, userAgent: meta.userAgent });
  if (!r.ok) {
    if (r.reason === "expired") redirect("/login");
    if (r.reason === "locked") return { error: `Слишком много неудачных попыток. Повторите через ${Math.max(1, Math.ceil(r.retryAfterSeconds / 60))} мин.` };
    return { error: "Код не подошёл или истёк. Попросите владельца выдать новый." };
  }
  redirect("/login/mfa");
}
