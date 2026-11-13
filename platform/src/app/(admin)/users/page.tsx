import type { Metadata } from "next";
import Link from "next/link";
import { listEnrolledUserIds } from "@/core/mfa";
import { ROLES } from "@/core/rbac";
import { listUsers } from "@/core/users";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";
import { changeRoleAction, createUserAction, resetMfaAction, resetPasswordAction, setActiveAction, setCanExportAction } from "./actions";

export const metadata: Metadata = { title: "Сотрудники" };

const ROLE_LABEL = { owner: "Владелец", manager: "Менеджер", editor: "Редактор" } as const;
const NOTICES: Record<string, string> = {
  created: "Сотрудник создан.",
  role: "Роль изменена. Сотрудника попросят войти заново.",
  active: "Статус изменён.",
  export: "Право на выгрузку изменено. Сотрудника попросят войти заново.",
  password: "Пароль изменён, все сессии сотрудника завершены.",
  mfa: "Второй фактор сброшен, сессии сотрудника завершены. При следующем входе он включит его заново.",
};

function errorText(code: string): string {
  if (code === "last_owner") return "Нельзя оставить систему без активного владельца.";
  if (code === "email_taken") return "Сотрудник с таким e-mail уже есть.";
  if (code === "forbidden") return "Недостаточно прав.";
  // Only fixed texts are ever shown: the code comes from the URL and must not be echoed back.
  if (code === "invalid_password") return "Пароль должен быть не короче 12 символов.";
  if (code === "invalid_email") return "Проверьте e-mail.";
  if (code === "invalid_name") return "Укажите имя.";
  if (code.startsWith("invalid_")) return "Проверьте введённые данные.";
  return "Не удалось выполнить действие.";
}

const input = "h-11 rounded-xl border-2 border-grape-200 bg-white px-3 text-base text-ink focus:border-grape-600 focus:outline-none";
const btn = "h-11 rounded-full bg-grape-700 px-5 text-sm font-extrabold text-white hover:bg-grape-600";
const btnGhost = "h-11 rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50";

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ notice?: string; error?: string }> }) {
  const { user } = await requirePermission("users.manage");
  const { notice, error } = await searchParams;
  const actor = { id: user.id, role: user.role };
  const users = await listUsers(getPool(), actor);
  const enrolled = await listEnrolledUserIds(getPool(), actor);
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" });

  return (
    <div className="crm-page">
      <header>
        <p className="crm-eyebrow">Доступ к CRM</p>
        <h1 className="crm-page-title">Сотрудники</h1>
        <p className="crm-page-subtitle">Роли, доступ к клиентским данным и состояние входа.</p>
      </header>
      {notice && NOTICES[notice] ? <p role="status" className="rounded-2xl bg-grape-100 p-3 text-sm font-bold text-grape-900">{NOTICES[notice]}</p> : null}
      {error ? <p role="alert" className="rounded-2xl bg-sun-100 p-3 text-sm font-bold text-grape-900">{errorText(error)}</p> : null}

      <section aria-labelledby="new" className="crm-panel">
        <h2 id="new" className="text-lg font-black text-grape-800">Создать учётную запись</h2>
        <p className="mt-1 text-xs text-muted">Задайте начальный пароль не короче 12 символов. Приглашение по e-mail в CRM не подключено.</p>
        <form action={createUserAction} className="mt-3 grid gap-3 sm:grid-cols-2">
          <input name="name" placeholder="Имя" required maxLength={120} autoComplete="off" className={input} aria-label="Имя" />
          <input name="email" type="email" placeholder="E-mail" required maxLength={254} autoComplete="off" className={input} aria-label="E-mail" />
          <select name="role" defaultValue="manager" className={input} aria-label="Роль">
            {ROLES.map((r) => (
              <option key={r} value={r}>{ROLE_LABEL[r]}</option>
            ))}
          </select>
          <label className="grid gap-1 text-xs font-bold text-muted">Начальный пароль (12+ символов)<input name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" className={input} aria-label="Начальный пароль" /></label>
          <button type="submit" className={`${btn} sm:col-span-2 sm:justify-self-start`}>Создать</button>
        </form>
      </section>

      <section aria-label="Список сотрудников" className="grid gap-3">
        {users.map((u) => (
          <article key={u.id} className={`crm-panel ${u.isActive ? "" : "opacity-70"}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-black text-grape-800">{u.name}</h3>
              <span className={`crm-status-badge ${u.isActive ? "" : "opacity-80"}`}>{u.isActive ? "Активен" : "Отключён"}</span>
            </div>
            <p className="text-sm text-muted">{u.email}</p>
            <p className="mt-1 text-xs text-muted">Роль: {ROLE_LABEL[u.role]} · Второй фактор: {enrolled.has(u.id) ? "включён" : "не включён"}</p>
            <p className="mt-1 text-xs text-muted">Последний вход: {u.lastLoginAt ? fmt.format(u.lastLoginAt) : "ещё не входил"} · <Link href={`/audit?userId=${encodeURIComponent(u.id)}`} className="font-bold text-grape-700 underline">Действия в журнале</Link></p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <form action={changeRoleAction} className="flex items-center gap-2">
                <input type="hidden" name="id" value={u.id} />
                <select name="role" defaultValue={u.role} className={input} aria-label={`Роль: ${u.name}`}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
                <button type="submit" className={btnGhost}>Сменить роль</button>
              </form>
              <form action={setActiveAction}>
                <input type="hidden" name="id" value={u.id} />
                <input type="hidden" name="active" value={u.isActive ? "0" : "1"} />
                <button type="submit" className={btnGhost}>{u.isActive ? "Отключить" : "Включить"}</button>
              </form>
            </div>
            {u.role === "manager" ? (
              <form action={setCanExportAction} className="crm-user-permission mt-3">
                <input type="hidden" name="id" value={u.id} />
                <input type="hidden" name="allowed" value={u.canExport ? "0" : "1"} />
                <div><strong className="text-sm text-grape-800">Выгрузка клиентской базы: {u.canExport ? "разрешена" : "запрещена"}</strong><p>Даёт доступ к файлу с персональными данными.</p></div>
                <button type="submit" className={btnGhost}>{u.canExport ? "Запретить выгрузку" : "Разрешить выгрузку"}</button>
              </form>
            ) : u.role === "owner" ? (
              <div className="crm-user-permission mt-3"><div><strong className="text-sm text-grape-800">Выгрузка клиентской базы: разрешена владельцу</strong><p>Это право закреплено за ролью владельца.</p></div></div>
            ) : null}
            {enrolled.has(u.id) && u.id !== user.id ? (
              <form action={resetMfaAction} className="mt-3">
                <input type="hidden" name="id" value={u.id} />
                <button type="submit" className={btnGhost}>Сбросить второй фактор</button>
              </form>
            ) : null}
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-extrabold text-grape-700">Задать новый пароль</summary>
              <form action={resetPasswordAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={u.id} />
                <input name="password" type="password" placeholder="Новый пароль" required minLength={12} maxLength={128} autoComplete="new-password" className={input} aria-label={`Новый пароль: ${u.name}`} />
                <button type="submit" className={btn}>Сохранить</button>
              </form>
            </details>
          </article>
        ))}
      </section>
    </div>
  );
}
