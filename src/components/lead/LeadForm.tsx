"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { CalendarBlank, WhatsappLogo, X } from "@phosphor-icons/react";
import {
  PACKAGE_OPTIONS,
  formatNationalPhone,
  minBookingDate,
  phoneDigits,
  validateLead,
  type LeadErrors,
  type LeadFields,
  type LeadPackage,
} from "@/lib/lead";
import { birthdayRooms } from "@/data/birthdayRooms";
import { getAttribution } from "@/lib/attribution";
import { errorTypeFromStatus, trackBirthday } from "@/lib/funnel";
import type { ErrorType } from "@/lib/funnel-core";
import { siteConfig } from "@/services/config";
import { buttonClass } from "@/components/ui/buttonStyles";
import { birthdayMessage, whatsappUrl } from "@/lib/whatsapp";
import { ChoiceField, type ChoiceOption } from "./ChoiceField";
import { useSelectedPackage } from "./SelectedPackage";
import { AvailabilityPanel, calendarEnabled } from "@/components/booking/AvailabilityPanel";
import { PreferredTime } from "@/components/booking/PreferredTime";

/** Inlined at build time: the artifact for the Kazakhstan server is built with NEXT_PUBLIC_SITE_PROFILE=kz-production. */
const KZ_PROFILE = process.env.NEXT_PUBLIC_SITE_PROFILE === "kz-production";

/** A random UUID; `crypto.randomUUID` exists only in secure contexts, so fall back to getRandomValues. */
function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Status = "idle" | "submitting" | "success" | "error";

const field =
  "h-12 w-full rounded-2xl sm:h-14 border-2 border-grape-200 bg-white px-4 text-base text-ink transition-colors placeholder:text-muted/70 focus:border-grape-600 focus:outline-none aria-[invalid=true]:border-lava-500";

const PACKAGE_CHOICES: ChoiceOption[] = PACKAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));
const ROOM_CHOICES: ChoiceOption[] = [
  { value: "", label: "Не выбрана" },
  ...birthdayRooms.map((r) => ({ value: r.id, label: r.name, image: { src: r.coverImage.src } })),
];

/** "2026-10-20" -> "вт, 20 октября 2026 г." (Russian regardless of the phone's system language). The value itself stays YYYY-MM-DD. */
const dateLabel = (iso: string): string | null =>
  /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
    : null;

export function LeadForm({
  initialPackage,
  initialRoom = "",
  onClose,
}: {
  initialPackage: LeadPackage;
  initialRoom?: string;
  onClose: () => void;
}) {
  const uid = useId();
  const [values, setValues] = useState<LeadFields>({
    name: "",
    phone: "",
    date: "",
    children: "",
    package: initialPackage,
    consent: false,
    room: initialRoom,
    slot: "",
  });
  const { setRoom: rememberRoom, setSelected: rememberPackage } = useSelectedPackage();
  const [errors, setErrors] = useState<LeadErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [errorKind, setErrorKind] = useState<"generic" | "rate">("generic");
  const [honeypot, setHoneypot] = useState("");
  // Synchronous guards: state updates are async, a fast double tap would otherwise get through.
  const inFlight = useRef(false);
  const succeeded = useRef(false);
  // One key per distinct enquiry: a retry after a lost answer reuses it (the server then creates nothing twice);
  // editing any field starts a new one.
  const idempotencyKey = useRef<string | null>(null);

  const set = <K extends keyof LeadFields>(key: K, value: LeadFields[K]) => {
    idempotencyKey.current = null;
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || succeeded.current) return;

    const funnel = { package_id: values.package, room_id: values.room, cta_source: "lead_form" };
    const fail = (error_type: ErrorType) => trackBirthday("birthday_lead_error", { ...funnel, error_type });
    trackBirthday("birthday_lead_submit_attempt", funnel);

    // The field holds only the 10 national digits ("707 123 45 67"); +7 is a fixed prefix.
    const national = phoneDigits(values.phone);
    const payload = { ...values, phone: national ? `+7${national}` : "" };
    const check = validateLead(payload);
    if (check.errors.phone && national) check.errors.phone = "Введите 10 цифр после +7";
    if (!check.ok) {
      setErrors(check.errors);
      fail("validation_client");
      const first = (Object.keys(check.errors) as (keyof LeadFields)[])[0];
      document.getElementById(`${uid}-${first}`)?.focus();
      return;
    }

    inFlight.current = true;
    setStatus("submitting");
    try {
      const attr = getAttribution();
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          website: honeypot,
          idempotencyKey: (idempotencyKey.current ??= newKey()),
          page: window.location.pathname + window.location.search,
          referrer: attr.referrer || document.referrer,
          utm_source: attr.utm_source,
          utm_medium: attr.utm_medium,
          utm_campaign: attr.utm_campaign,
        }),
      });
      const data = await res.json().catch(() => ({}));
      // Success only when the server confirms that Telegram accepted the lead (HTTP 200 + ok:true).
      if (res.ok && data.ok === true) {
        succeeded.current = true;
        // Also true for a repeat of an already delivered lead (e.g. the first answer was lost): the server
        // only says duplicate for leads it really delivered. Counted once per open form (`succeeded`).
        trackBirthday("birthday_lead_success", funnel);
        setStatus("success");
        return;
      }
      fail(errorTypeFromStatus(res.status));
      if (res.status === 400 && data.fieldErrors) {
        setErrors(data.fieldErrors);
        setStatus("idle");
        return;
      }
      setErrorKind(res.status === 429 ? "rate" : "generic");
      setStatus("error");
    } catch {
      fail("network");
      setErrorKind("generic");
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }

  const header = (
    <div className="flex items-start justify-between gap-4">
      <h2 id="lead-title" className="font-display text-[1.375rem] font-black leading-tight tracking-tight text-grape-800 sm:text-3xl">
        {status === "success" ? "Спасибо!" : "Забронировать праздник"}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        className="group -mr-2.5 -mt-2.5 flex h-11 w-11 shrink-0 items-center justify-center"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-grape-100 text-grape-800 transition-colors group-hover:bg-grape-200">
          <X size={16} weight="bold" aria-hidden="true" />
        </span>
      </button>
    </div>
  );

  if (status === "success") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 px-5 pt-5 sm:px-8 sm:pt-8">{header}</div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 sm:px-8">
          <p role="status" className="mt-4 text-lg leading-relaxed text-grape-900">
            Заявка отправлена. Менеджер свяжется с вами.
          </p>
        </div>
        <div className="shrink-0 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-8">
          <button type="button" onClick={onClose} className={buttonClass("primary", "w-full")}>
            Закрыть
          </button>
          <a
            href={siteConfig.contacts.instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 flex h-12 items-center justify-center font-display text-base font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4"
          >
            Instagram {siteConfig.contacts.instagramHandle}
          </a>
        </div>
      </div>
    );
  }

  // Fallback when delivery fails: WhatsApp with the package and room chosen in this form (a click is not a lead).
  const whatsappLink = whatsappUrl(birthdayMessage({ packageId: values.package, roomId: values.room }));
  const idOf = (k: keyof LeadFields) => `${uid}-${k}`;
  const err = (k: keyof LeadFields) =>
    errors[k] ? (
      <p id={`${idOf(k)}-err`} className="mt-1.5 text-sm font-semibold text-[#b3261e]">
        {errors[k]}
      </p>
    ) : null;
  const aria = (k: keyof LeadFields) => ({
    "aria-invalid": errors[k] ? true : undefined,
    "aria-describedby": errors[k] ? `${idOf(k)}-err` : undefined,
  });

  const whatsapp = whatsappLink ? (
    <>
      <div aria-hidden="true" className="my-2 flex items-center gap-3 text-sm font-semibold text-muted">
        <span className="h-px flex-1 bg-line" />
        или
        <span className="h-px flex-1 bg-line" />
      </div>
      <a href={whatsappLink} target="_blank" rel="noopener noreferrer" className={buttonClass("outline", "w-full")}>
        <WhatsappLogo size={22} weight="bold" aria-hidden="true" />
        Написать в WhatsApp
      </a>
      <p className="mt-1.5 text-center text-[0.8125rem] leading-snug text-muted">Откроется WhatsApp с готовым сообщением</p>
    </>
  ) : null;

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 pt-5 sm:px-8 sm:pt-8">
        {header}
        <p className="mt-1 text-base text-muted">Менеджер свяжется с вами.</p>
      </div>

      {/* The ONLY scrolling zone of the sheet. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4 pt-4 sm:px-8 sm:pb-5 sm:pt-6">
      <div className="grid gap-4 sm:gap-5">
        <div className="grid gap-2">
          <label htmlFor={idOf("name")} className="font-display text-sm font-extrabold text-grape-800">
            Ваше имя
          </label>
          <input
            id={idOf("name")}
            name="name"
            type="text"
            autoComplete="name"
            required
            maxLength={80}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            className={field}
            {...aria("name")}
          />
          {err("name")}
        </div>

        <div className="grid gap-2">
          <label htmlFor={idOf("phone")} className="font-display text-sm font-extrabold text-grape-800">
            Телефон<span className="sr-only"> (после +7 — 10 цифр)</span>
          </label>
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base font-semibold text-grape-800"
            >
              +7
            </span>
            <input
              id={idOf("phone")}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              required
              placeholder="707 123 45 67"
              value={values.phone}
              onChange={(e) => {
                // One typed character is never a country code; paste/autofill/replace may contain one.
                const ne = e.nativeEvent as InputEvent;
                const typed = ne.inputType === "insertText" && ne.data?.length === 1;
                set("phone", formatNationalPhone(phoneDigits(e.target.value, !typed)));
              }}
              className={`${field} pl-11`}
              {...aria("phone")}
            />
          </div>
          {err("phone")}
        </div>

        <div className="grid gap-4 sm:grid-cols-[1.4fr_1fr] sm:gap-3">
          <div className="grid content-start gap-2">
            <label htmlFor={idOf("date")} className="font-display text-sm font-extrabold text-grape-800 sm:flex sm:min-h-10 sm:items-end">
              Желаемая дата
            </label>
            {/* One date system: the native input is the single source of truth (YYYY-MM-DD) and does the picking; it sits
                invisibly over a Russian-language display, so an English-language phone still shows "20 октября 2026 г.". */}
            <div className="relative rounded-2xl has-[input:focus-visible]:outline has-[input:focus-visible]:outline-[3px] has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-grape-500">
              <div
                aria-hidden="true"
                className={`${field} flex items-center justify-between gap-2 ${errors.date ? "border-lava-500" : ""} ${dateLabel(values.date) ? "font-semibold text-ink" : "text-muted/70"}`}
              >
                <span className="min-w-0 truncate">{dateLabel(values.date) ?? "Выберите дату"}</span>
                <CalendarBlank size={20} weight="bold" className="shrink-0 text-grape-700" />
              </div>
              <input
                id={idOf("date")}
                name="date"
                type="date"
                lang="ru"
                required
                min={minBookingDate()}
                value={values.date}
                onChange={(e) => set("date", e.target.value)}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker?.();
                  } catch {
                    /* the browser decides when it may open a picker */
                  }
                }}
                className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-2xl opacity-0 focus:outline-none focus-visible:outline-none"
                style={{ colorScheme: "light" }}
                {...aria("date")}
              />
            </div>
            {err("date")}
          </div>
          <div className="grid content-start gap-2">
            <label htmlFor={idOf("children")} className="font-display text-sm font-extrabold text-grape-800 sm:flex sm:min-h-10 sm:items-end">
              <span>
                Количество детей <span className="font-medium text-muted">(по желанию)</span>
              </span>
            </label>
            <input
              id={idOf("children")}
              name="children"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={2}
              placeholder="Например, 8"
              value={values.children}
              onChange={(e) => set("children", e.target.value.replace(/\D/g, "").slice(0, 2))}
              className={field}
              {...aria("children")}
            />
            {err("children")}
          </div>
        </div>

        {calendarEnabled ? (
          <AvailabilityPanel
            date={values.date}
            packageId={values.package}
            slot={values.slot}
            onSlot={(id) => set("slot", id)}
            onPickDate={(d) => set("date", d)}
            minDate={minBookingDate()}
          />
        ) : (
          <PreferredTime slot={values.slot} onSlot={(id) => set("slot", id)} />
        )}

        <div className="grid gap-2">
          <span id={`${idOf("package")}-label`} className="font-display text-sm font-extrabold text-grape-800">
            Пакет праздника
          </span>
          <ChoiceField
            id={idOf("package")}
            labelledBy={`${idOf("package")}-label`}
            name="package"
            value={values.package}
            options={PACKAGE_CHOICES}
            invalid={!!errors.package}
            describedBy={errors.package ? `${idOf("package")}-err` : undefined}
            onChange={(next) => {
              if (next !== values.package) trackBirthday("birthday_package_select", { package_id: next, room_id: values.room, cta_source: "form" });
              set("package", next as LeadPackage);
              rememberPackage(next as LeadPackage);
            }}
          />
          {err("package")}
        </div>

        <div className="grid gap-2">
          <span id={`${idOf("room")}-label`} className="font-display text-sm font-extrabold text-grape-800">
            Предпочитаемая комната <span className="font-medium text-muted">(по желанию)</span>
          </span>
          <ChoiceField
            id={idOf("room")}
            labelledBy={`${idOf("room")}-label`}
            name="room"
            value={values.room}
            options={ROOM_CHOICES}
            invalid={!!errors.room}
            describedBy={errors.room ? `${idOf("room")}-err ${idOf("room")}-hint` : `${idOf("room")}-hint`}
            onChange={(next) => {
              if (next && next !== values.room) trackBirthday("birthday_room_select", { package_id: values.package, room_id: next, cta_source: "form" });
              set("room", next);
              rememberRoom(next);
            }}
          />
          <p id={`${idOf("room")}-hint`} className="text-[0.8125rem] leading-snug text-muted">
            Это пожелание: выбор не гарантирует, что комната свободна на вашу дату.
          </p>
          {err("room")}
        </div>

        <div className="grid gap-1">
          <label htmlFor={idOf("consent")} className="flex min-h-11 cursor-pointer items-center gap-3 py-1 text-[0.8125rem] leading-snug text-grape-900">
            <input
              id={idOf("consent")}
              name="consent"
              type="checkbox"
              checked={values.consent}
              onChange={(e) => set("consent", e.target.checked)}
              className="h-5 w-5 shrink-0 cursor-pointer accent-grape-700"
              {...aria("consent")}
            />
            <span>
              Я согласен(на) на{" "}
              <a
                href="/privacy"
                target="_blank"
                rel="noopener"
                className="font-semibold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2"
              >
                обработку персональных данных
              </a>{" "}
              для связи по заявке.
            </span>
          </label>
          <p className="mt-1.5 pl-8 text-xs leading-relaxed text-muted">
            {KZ_PROFILE ? (
              <>
                Имя и телефон из заявки сохраняются в CRM Boom Bala на сервере в Республике Казахстан. В Telegram сотрудникам уходит только уведомление без имени и телефона.
                <span lang="kk" className="block">Өтінімдегі ат пен телефон Boom Bala CRM-ында Қазақстан Республикасындағы серверде сақталады. Telegram-ға қызметкерлерге тек ат пен телефонсыз хабарландыру жіберіледі.</span>
              </>
            ) : (
              <>
                Имя и телефон из заявки передаются сотрудникам Boom Bala через сервис Telegram; обработка может происходить за пределами Республики Казахстан. Передача не означает согласия на публикацию или рекламу ваших данных.
                <span lang="kk" className="block">Өтінімдегі ат пен телефон қызметкерлерге Telegram сервисі арқылы жіберіледі; деректер Қазақстаннан тыс жерде өңделуі мүмкін. Бұл деректерді жариялауға немесе жарнамалауға келісім емес.</span>
              </>
            )}
          </p>
          {err("consent")}
        </div>

        {/* Honeypot: hidden from people and assistive tech, bots tend to fill it. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>
            Website
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="sheet-show-compact mt-4">{whatsapp}</div>
      </div>

      {/* Actions: always visible, never over the fields. */}
      <div className="shrink-0 border-t border-line bg-paper px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:px-8 sm:pb-8 sm:pt-4">
      {status === "error" ? (
        <p role="alert" className="mb-3 max-h-32 overflow-y-auto rounded-2xl bg-sun-100 p-4 text-base font-semibold text-grape-900">
          {errorKind === "rate"
            ? "Слишком много попыток. Попробуйте чуть позже."
            : whatsappLink
              ? "Не удалось отправить заявку. Попробуйте ещё раз или напишите нам в WhatsApp."
              : "Не удалось отправить заявку. Попробуйте ещё раз или напишите нам в Instagram."}{" "}
          <a
            href={whatsappLink ?? siteConfig.contacts.instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-2 underline-offset-2"
          >
            {whatsappLink ? "Написать в WhatsApp" : siteConfig.contacts.instagramHandle}
          </a>
        </p>
      ) : null}

      <button type="submit" disabled={status === "submitting"} className={buttonClass("primary", "w-full disabled:opacity-60")}>
        {status === "submitting" ? "Отправляем…" : "Отправить заявку"}
      </button>
      {/* Second, equal way to reach us. A plain link built from the CURRENT form fields: it does not validate or
          submit the form, needs no consent tick, is not a lead and fires no analytics. On very short screens
          (landscape, keyboard open) it moves from here to the end of the scrolling area so the main button keeps its room. */}
      <div className="sheet-hide-compact">{whatsapp}</div>
      </div>
    </form>
  );
}
