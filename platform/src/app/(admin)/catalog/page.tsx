import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { requirePermission } from "@/server/dal";
import { FastApiCrmClient, unifiedFastapiCrmEnabled } from "@/server/fastapi-crm";
import { fastApiActorForStaff } from "@/server/fastapi-staff";
import { createCatalogPackageAction, updateCatalogPackageAction } from "./actions";

export const metadata: Metadata = { title: "Пакеты и цены" };

const money = new Intl.NumberFormat("ru-RU");
const notices: Record<string, string> = {
  saved: "Изменения пакета сохранены в FastAPI.",
  created: "Пакет создан в FastAPI.",
  invalid: "Проверь обязательные поля и числовые значения.",
  branch: "В каталоге должно быть ровно одно доступное отделение.",
  unavailable: "Редактирование каталога включится вместе с FastAPI CRM.",
  failed: "FastAPI не сохранила изменения. Проверь данные и попробуй ещё раз.",
};

function PackageFields({ item, action }: {
  item: {
    id?: string;
    slug?: string;
    name?: string;
    priceFrom?: number;
    priceLabel?: string;
    guestCapacityLabel?: string;
    description?: string;
    displayOrder?: number;
    isActive?: boolean;
    isFeatured?: boolean;
  };
  action: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form action={action} className="crm-detail-form crm-catalog-form">
      {item.id ? <input type="hidden" name="packageId" value={item.id} /> : null}
      <label className="crm-detail-field"><span>Название</span><input name="name" required minLength={2} maxLength={255} defaultValue={item.name} /></label>
      <label className="crm-detail-field"><span>Адрес пакета</span><input name="slug" required minLength={2} maxLength={120} defaultValue={item.slug} /></label>
      <label className="crm-detail-field"><span>Цена, ₸</span><input name="priceFrom" type="number" min="0" max="10000000" step="1" required defaultValue={item.priceFrom} /></label>
      <label className="crm-detail-field"><span>Подпись цены</span><input name="priceLabel" required maxLength={64} defaultValue={item.priceLabel} placeholder="от 40 000 ₸" /></label>
      <label className="crm-detail-field"><span>Вместимость</span><input name="guestCapacityLabel" required maxLength={64} defaultValue={item.guestCapacityLabel} /></label>
      <label className="crm-detail-field"><span>Порядок показа</span><input name="displayOrder" type="number" min="0" max="1000" step="1" required defaultValue={item.displayOrder ?? 0} /></label>
      <label className="crm-detail-field crm-catalog-description"><span>Описание</span><textarea name="description" required minLength={10} maxLength={5000} rows={4} defaultValue={item.description} /></label>
      <div className="crm-catalog-switches">
        <label><input type="checkbox" name="isActive" defaultChecked={item.isActive ?? true} /> Показывать пакет</label>
        <label><input type="checkbox" name="isFeatured" defaultChecked={item.isFeatured ?? false} /> Рекомендуемый</label>
      </div>
      <button type="submit" className="crm-detail-button">{item.id ? "Сохранить пакет" : "Создать пакет"}</button>
    </form>
  );
}

export default async function CatalogPage({ searchParams }: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { user } = await requirePermission("prices.manage");
  if (!unifiedFastapiCrmEnabled()) notFound();
  const params = await searchParams;
  let branchName = "";
  let packages: Awaited<ReturnType<FastApiCrmClient["getAdminBirthdayPackage"]>>[] = [];
  let unavailable = false;
  try {
    const actor = await fastApiActorForStaff({ id: user.id, email: user.email, role: user.role }, { requestId: randomUUID() });
    const client = new FastApiCrmClient(actor);
    const catalog = await client.getBookingCatalog();
    if (catalog.branches.length !== 1) throw new Error("single_branch_required");
    branchName = catalog.branches[0].name;
    const summaries = await client.listAdminBirthdayPackages(catalog.branches[0].id);
    packages = await Promise.all(summaries.map((item) => client.getAdminBirthdayPackage(item.id)));
  } catch {
    unavailable = true;
  }
  return (
    <div className="crm-page crm-catalog-page">
      <header className="crm-page-heading">
        <div><p className="crm-eyebrow">Единый каталог FastAPI</p><h1 className="crm-page-title">Пакеты и цены</h1><p className="crm-page-subtitle">Изменения отсюда сразу становятся источником каталога сайта и CRM.</p></div>
      </header>
      {params.notice && notices[params.notice] ? <p className="crm-detail-message" role="status">{notices[params.notice]}</p> : null}
      {unavailable ? <p className="crm-detail-message crm-detail-message-error" role="alert">Не удалось загрузить FastAPI каталог или доступна не одна площадка. Сохранение отключено.</p> : null}
      {branchName ? <p className="crm-catalog-branch">Филиал: <strong>{branchName}</strong></p> : null}
      {!unavailable ? <section className="crm-catalog-list" aria-label="Пакеты филиала">
        {packages.map((item) => (
          <article key={item.id} className="crm-detail-panel crm-catalog-item">
            <header><div><p className="crm-eyebrow">{item.slug}</p><h2>{item.name}</h2></div><strong>{money.format(item.priceFrom)} ₸</strong></header>
            <PackageFields action={updateCatalogPackageAction} item={item} />
          </article>
        ))}
        {!packages.length ? <p className="crm-detail-help">Пакетов в филиале пока нет.</p> : null}
      </section> : null}
      {!unavailable ? <section className="crm-detail-panel crm-catalog-create" aria-label="Создать пакет">
        <p className="crm-eyebrow">Каталог филиала</p><h2>Добавить пакет</h2>
        <PackageFields action={createCatalogPackageAction} item={{ displayOrder: packages.length }} />
      </section> : null}
    </div>
  );
}
