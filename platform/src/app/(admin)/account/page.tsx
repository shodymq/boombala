import type { Metadata } from "next";
import { requireUser } from "@/server/dal";
import { listPasskeys } from "@/core/passkeys";
import { getPool } from "@/server/db";
import { passkeysAvailable } from "@/server/env";
import { changeOwnPasswordAction, revokeOwnPasskeyAction } from "./actions";
import { PasskeyAdd } from "./passkey-add";

export const metadata: Metadata = { title: "Мой пароль" };

// Fixed texts only: the code comes from the URL and must never be echoed back.
const ERRORS: Record<string, string> = {
  mismatch: "Новые пароли не совпадают.",
  current: "Неверный текущий пароль.",
  weak: "Новый пароль должен быть не короче 12 символов.",
  passkey: "Не удалось отозвать ключ.",
};

const input = "h-12 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink focus:border-grape-600 focus:outline-none";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { user } = await requireUser();
  const { notice, error } = await searchParams;
  const keys = passkeysAvailable ? await listPasskeys(getPool(), user.id) : [];
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });
  return (
    <div className="grid max-w-md gap-4">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Мой пароль</h1>
      {notice === "passkey_revoked" ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">Ключ отозван: с этого устройства войти им больше нельзя.</p> : notice ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">Пароль изменён. На других устройствах вы будете разлогинены.</p> : null}
      {error ? (
        <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">
          {ERRORS[error] ?? "Не удалось сменить пароль."}
        </p>
      ) : null}
      <form action={changeOwnPasswordAction} className="grid gap-3 rounded-3xl border border-line bg-white p-5">
        <input name="current" type="password" placeholder="Текущий пароль" required autoComplete="current-password" maxLength={128} className={input} aria-label="Текущий пароль" />
        <input name="next" type="password" placeholder="Новый пароль (минимум 12 символов)" required minLength={12} maxLength={128} autoComplete="new-password" className={input} aria-label="Новый пароль" />
        <input name="repeat" type="password" placeholder="Повторите новый пароль" required minLength={12} maxLength={128} autoComplete="new-password" className={input} aria-label="Повторите новый пароль" />
        <button type="submit" className="h-12 rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600">Сменить пароль</button>
      </form>
      {passkeysAvailable ? (
        <section aria-labelledby="passkeys" className="grid gap-3 rounded-3xl border border-line bg-white p-5" data-testid="passkeys">
          <h2 id="passkeys" className="text-lg font-black text-grape-800">Face ID / Touch ID</h2>
          <p className="text-sm text-muted">Вход без пароля и кода: подтверждаете отпечатком, лицом или кодом устройства. Пароль и код остаются запасным входом.</p>
          {keys.length === 0 ? <p className="text-sm text-muted" data-testid="passkey-empty">Устройств пока нет.</p> : null}
          <ul className="grid gap-2" data-testid="passkey-list">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line p-3">
                <div className="min-w-0">
                  <p className="font-black text-grape-900 [overflow-wrap:anywhere]">{k.label}</p>
                  <p className="text-xs text-muted">
                    Добавлено {fmt.format(new Date(k.createdAt))} · {k.lastUsedAt ? `вход: ${fmt.format(new Date(k.lastUsedAt))}` : "ещё не использовался"}
                    {k.backedUp ? " · синхронизируется (iCloud/Google)" : ""}
                  </p>
                </div>
                <form action={revokeOwnPasskeyAction}>
                  <input type="hidden" name="id" value={k.id} />
                  <button type="submit" className="h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50">Отозвать</button>
                </form>
              </li>
            ))}
          </ul>
          <PasskeyAdd />
        </section>
      ) : null}
    </div>
  );
}
