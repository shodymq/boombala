"use client";

import { useId, useState, type FormEvent } from "react";
import { X } from "@phosphor-icons/react";
import { PACKAGE_OPTIONS, minBookingDate, validateLead, type LeadErrors, type LeadFields, type LeadPackage } from "@/lib/lead";
import { getAttribution } from "@/lib/attribution";
import { track } from "@/lib/analytics";
import { siteConfig } from "@/services/config";
import { buttonClass } from "@/components/ui/buttonStyles";

type Status = "idle" | "submitting" | "success" | "error";

const field =
  "h-12 w-full rounded-2xl sm:h-14 border-2 border-grape-200 bg-white px-4 text-base text-ink transition-colors placeholder:text-muted/70 focus:border-grape-600 focus:outline-none aria-[invalid=true]:border-lava-500";

export function LeadForm({ initialPackage, onClose }: { initialPackage: LeadPackage; onClose: () => void }) {
  const uid = useId();
  const [values, setValues] = useState<LeadFields>({
    name: "",
    phone: "",
    date: "",
    children: "",
    package: initialPackage,
  });
  const [errors, setErrors] = useState<LeadErrors>({});
  const [status, setStatus] = useState<Status>("idle");
  const [errorKind, setErrorKind] = useState<"generic" | "rate">("generic");
  const [honeypot, setHoneypot] = useState("");

  const set = <K extends keyof LeadFields>(key: K, value: LeadFields[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    const check = validateLead(values);
    if (!check.ok) {
      setErrors(check.errors);
      const first = (Object.keys(check.errors) as (keyof LeadFields)[])[0];
      document.getElementById(`${uid}-${first}`)?.focus();
      return;
    }
    setStatus("submitting");
    try {
      const attr = getAttribution();
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          website: honeypot,
          page: window.location.pathname + window.location.search,
          referrer: attr.referrer || document.referrer,
          utm_source: attr.utm_source,
          utm_medium: attr.utm_medium,
          utm_campaign: attr.utm_campaign,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        track("SubmitLead", { package: values.package, page: window.location.pathname });
        setStatus("success");
        return;
      }
      if (res.status === 400 && data.fieldErrors) {
        setErrors(data.fieldErrors);
        setStatus("idle");
        return;
      }
      setErrorKind(res.status === 429 ? "rate" : "generic");
      setStatus("error");
    } catch {
      setErrorKind("generic");
      setStatus("error");
    }
  }

  const header = (
    <div className="flex items-start justify-between gap-4">
      <h2 id="lead-title" className="font-display text-2xl font-black leading-tight tracking-tight text-grape-800 sm:text-3xl">
        {status === "success" ? "Спасибо!" : "Забронировать праздник"}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-grape-800 transition-colors hover:bg-grape-100"
      >
        <X size={22} weight="bold" aria-hidden="true" />
      </button>
    </div>
  );

  if (status === "success") {
    return (
      <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-8">
        {header}
        <p role="status" className="mt-4 text-lg leading-relaxed text-grape-900">
          Заявка отправлена. Менеджер свяжется с вами.
        </p>
        <button type="button" onClick={onClose} className={buttonClass("primary", "mt-8 w-full")}>
          Закрыть
        </button>
        <a
          href={siteConfig.contacts.instagram}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 flex h-12 items-center justify-center font-display text-base font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4"
        >
          Instagram {siteConfig.contacts.instagramHandle}
        </a>
      </div>
    );
  }

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

  return (
    <form onSubmit={onSubmit} noValidate className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-8">
      {header}
      <p className="mt-1 text-base text-muted">Менеджер свяжется с вами.</p>

      <div className="mt-4 grid gap-4 sm:mt-6 sm:gap-5">
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
            Телефон
          </label>
          <input
            id={idOf("phone")}
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            placeholder="+7"
            value={values.phone}
            onChange={(e) => set("phone", e.target.value)}
            className={field}
            {...aria("phone")}
          />
          {err("phone")}
        </div>

        <div className="grid grid-cols-[1.4fr_1fr] gap-3">
          <div className="grid content-start gap-2">
            <label htmlFor={idOf("date")} className="font-display text-sm font-extrabold text-grape-800">
              Желаемая дата
            </label>
            <input
              id={idOf("date")}
              name="date"
              type="date"
              required
              min={minBookingDate()}
              value={values.date}
              onChange={(e) => set("date", e.target.value)}
              className={field}
              {...aria("date")}
            />
            {err("date")}
          </div>
          <div className="grid content-start gap-2">
            <label htmlFor={idOf("children")} className="font-display text-sm font-extrabold text-grape-800">
              Детей <span className="font-medium text-muted">(по желанию)</span>
            </label>
            <input
              id={idOf("children")}
              name="children"
              type="number"
              inputMode="numeric"
              min={1}
              max={60}
              value={values.children}
              onChange={(e) => set("children", e.target.value)}
              className={field}
              {...aria("children")}
            />
            {err("children")}
          </div>
        </div>

        <div className="grid gap-2">
          <label htmlFor={idOf("package")} className="font-display text-sm font-extrabold text-grape-800">
            Пакет
          </label>
          <select
            id={idOf("package")}
            name="package"
            value={values.package}
            onChange={(e) => set("package", e.target.value as LeadPackage)}
            className={field}
            {...aria("package")}
          >
            {PACKAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {err("package")}
        </div>

        {/* Honeypot: hidden from people and assistive tech, bots tend to fill it. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>
            Website
            <input type="text" name="website" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </label>
        </div>
      </div>

      {status === "error" ? (
        <p role="alert" className="mt-5 rounded-2xl bg-sun-100 p-4 text-base font-semibold text-grape-900">
          {errorKind === "rate"
            ? "Слишком много попыток. Попробуйте чуть позже."
            : "Не удалось отправить заявку. Попробуйте ещё раз или напишите нам в Instagram."}{" "}
          <a
            href={siteConfig.contacts.instagram}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-2 underline-offset-2"
          >
            {siteConfig.contacts.instagramHandle}
          </a>
        </p>
      ) : null}

      <button type="submit" disabled={status === "submitting"} className={buttonClass("primary", "mt-5 w-full disabled:opacity-60")}>
        {status === "submitting" ? "Отправляем…" : "Отправить заявку"}
      </button>
    </form>
  );
}
