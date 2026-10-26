import type { ParentCabinet } from "@/lib/parent/core";
import { ParentLogoutButton } from "./ParentLogoutButton";

const GROUP_TITLE = { waiting: "Ожидают ответа", confirmed: "Подтверждены", finished: "Завершённые", cancelled: "Не состоялись" } as const;
const GROUP_ORDER = ["waiting", "confirmed", "finished", "cancelled"] as const;

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Almaty" });

/** Personal cabinet view. Rendered on the server from the BFF data; receives no FastAPI token. */
export function Cabinet({ data, csrfToken }: { data: ParentCabinet; csrfToken: string }) {
  const name = [data.parent.firstName, data.parent.lastName].filter(Boolean).join(" ") || "Здравствуйте";
  return (
    <section className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-extrabold text-grape-900">{name}</h1>
          {data.parent.phone ? <p className="text-grape-700">{data.parent.phone}</p> : null}
        </div>
        <ParentLogoutButton csrfToken={csrfToken} />
      </header>

      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h2 className="font-display text-xl font-extrabold text-grape-900">Дети</h2>
        {data.children.length === 0 ? (
          <p className="mt-2 text-grape-700">Пока нет добавленных детей. Добавить можно в приложении Boom Bala.</p>
        ) : (
          <ul className="mt-3 divide-y divide-grape-100">
            {data.children.map((c) => (
              <li key={c.id} className="py-3">
                <span className="font-bold text-grape-900">{c.name}</span>{" "}
                <span className="text-sm text-grape-700">{dateFmt.format(new Date(c.birthDate))}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-3xl bg-white p-6 shadow-sm">
        <h2 className="font-display text-xl font-extrabold text-grape-900">Мои заявки на праздник</h2>
        {data.requests.length === 0 ? (
          <p className="mt-2 text-grape-700">Заявок пока нет. Заявка не резервирует слот: менеджер подтверждает бронь.</p>
        ) : (
          GROUP_ORDER.map((group) => {
            const items = data.requests.filter((r) => r.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="mt-4">
                <h3 className="text-sm font-extrabold uppercase tracking-wide text-grape-700">{GROUP_TITLE[group]}</h3>
                <ul className="mt-2 space-y-3">
                  {items.map((r) => (
                    <li key={r.id} className="rounded-2xl border border-grape-100 p-4">
                      <p className="font-bold text-grape-900">{r.statusLabel}</p>
                      <p className="text-sm text-grape-700">
                        {[r.packageName, r.childName, r.branchName, r.requestedDate ? dateFmt.format(new Date(r.requestedDate)) : null, r.guestCount ? `гостей: ${r.guestCount}` : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
