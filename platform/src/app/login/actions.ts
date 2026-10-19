"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticate } from "../../core/auth.ts";
import { MAX_PASSWORD_LENGTH } from "../../core/password.ts";
import { revokeSession } from "../../core/session.ts";
import { getPool } from "../../server/db.ts";
import { SESSION_COOKIE, isHttps } from "../../server/env.ts";
import { requestMeta } from "../../server/request.ts";

export interface LoginState {
  error?: string;
}

const schema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export async function login(_prev: LoginState | undefined, formData: FormData): Promise<LoginState> {
  const parsed = schema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Введите e-mail и пароль." };
  const meta = await requestMeta();
  const result = await authenticate(getPool(), { ...parsed.data, ip: meta.ip, userAgent: meta.userAgent });
  if (!result.ok) {
    if (result.reason === "locked") {
      return { error: `Слишком много неудачных попыток. Повторите через ${Math.max(1, Math.ceil(result.retryAfterSeconds / 60))} мин.` };
    }
    return { error: "Неверный e-mail или пароль." };
  }
  (await cookies()).set(SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    expires: result.expiresAt,
  });
  redirect("/");
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(getPool(), token);
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
