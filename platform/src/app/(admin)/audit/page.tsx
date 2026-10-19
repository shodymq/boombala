import type { Metadata } from "next";
import { requirePermission } from "@/server/dal";
import { getPool } from "@/server/db";

export const metadata: Metadata = { title: "Журнал действий" };

interface Row {
  id: string;
  at: Date;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  actor: string | null;
  detail: string | null;
}

export default async function AuditPage() {
  await requirePermission("audit.view");
  const { rows } = await getPool().query<Row>(
    `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, u.name AS actor,
            left(coalesce(a.after, a.before)::text, 160) AS detail
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      ORDER BY a.id DESC LIMIT 200`,
  );
  const fmt = new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "medium", timeZone: "Asia/Almaty" });
  return (
    <div className="grid gap-4">
      <h1 className="text-3xl font-black tracking-tight text-grape-800">Журнал действий</h1>
      <p className="text-sm text-muted">Последние 200 записей. Журнал нельзя изменить или удалить.</p>
      <div className="overflow-x-auto rounded-3xl border border-line bg-white">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="bg-grape-50 text-muted">
            <tr>
              <th className="px-3 py-2 font-semibold">Время (Алматы)</th>
              <th className="px-3 py-2 font-semibold">Кто</th>
              <th className="px-3 py-2 font-semibold">Действие</th>
              <th className="px-3 py-2 font-semibold">Объект и детали</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{fmt.format(r.at)}</td>
                <td className="px-3 py-2">{r.actor ?? "система"}</td>
                <td className="px-3 py-2 font-bold">{r.action}</td>
                <td className="px-3 py-2 text-muted">
                  {r.entity_type ? `${r.entity_type} ${r.entity_id ?? ""}` : ""}
                  {r.detail ? <span className="block break-all text-xs">{r.detail}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
