"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { formatNationalPhone, phoneDigits } from "@/lib/lead";
import { buttonClass } from "@/components/ui/buttonStyles";

interface Doc {
  kind: string;
  version: number;
  title: string;
  body: string;
}

const field =
  "h-12 w-full rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink transition-colors placeholder:text-muted/70 focus:border-grape-600 focus:outline-none aria-[invalid=true]:border-lava-500";

function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Name, optional phone, acknowledgement of the rules and a SEPARATE consent to personal data processing. Nothing else. */
export function ConsentForm({ documents }: { documents: Doc[] }) {
  const uid = useId();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [rules, setRules] = useState(false);
  const [data, setData] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const inFlight = useRef(false);
  const key = useRef<string | null>(null);
  const rulesDocs = documents.filter((d) => d.kind !== "personal_data_consent");
  const dataDoc = documents.find((d) => d.kind === "personal_data_consent");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || status === "success") return;
    const next: Record<string, string> = {};
    const national = phoneDigits(phone);
    if (name.trim().length < 2) next.name = "Укажите имя";
    if (national.length > 0 && national.length !== 10) next.phone = "Введите 10 цифр после +7 или оставьте поле пустым";
    if (!rules) next.acceptRules = "Подтвердите, что ознакомились с правилами";
    if (!data) next.acceptPersonalData = "Необходимо согласие на обработку данных";
    setErrors(next);
    if (Object.keys(next).length) return;

    inFlight.current = true;
    setStatus("submitting");
    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...(national ? { phone: `+7${national}` } : {}), acceptRules: rules, acceptPersonalData: data, website: honeypot, idempotencyKey: (key.current ??= newKey()) }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok === true) return setStatus("success");
      if (res.status === 400 && body.fieldErrors) {
        setErrors(body.fieldErrors);
        return setStatus("idle");
      }
      setStatus("error");
    } catch {
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }

  if (status === "success") {
    return (
      <p role="status" className="mt-6 text-lg leading-relaxed text-grape-900">
        Спасибо! Регистрация сохранена. Это не отметка о посещении.
      </p>
    );
  }

  const err = (k: string) => (errors[k] ? <p className="mt-1.5 text-sm font-semibold text-[#b3261e]">{errors[k]}</p> : null);
  const docLink = (d: Doc) => (
    <details key={d.kind} className="mt-2 rounded-2xl border border-grape-200 bg-white p-3 text-sm">
      <summary className="cursor-pointer font-semibold text-grape-700">
        {d.title} (редакция {d.version})
      </summary>
      <div className="mt-2 whitespace-pre-wrap text-grape-900">{d.body}</div>
    </details>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="mt-6 grid gap-5">
      <div className="grid gap-2">
        <label htmlFor={`${uid}-name`} className="font-display text-sm font-extrabold text-grape-800">Ваше имя</label>
        <input id={`${uid}-name`} name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={field} aria-invalid={errors.name ? true : undefined} />
        {err("name")}
      </div>
      <div className="grid gap-2">
        <label htmlFor={`${uid}-phone`} className="font-display text-sm font-extrabold text-grape-800">Телефон для экстренной связи <span className="font-normal text-muted">(необязательно)</span></label>
        <div className="relative">
          <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base font-semibold text-grape-800">+7</span>
          <input id={`${uid}-phone`} name="phone" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="707 123 45 67" value={phone} onChange={(e) => setPhone(formatNationalPhone(phoneDigits(e.target.value, true)))} className={`${field} pl-11`} aria-invalid={errors.phone ? true : undefined} />
        </div>
        {err("phone")}
      </div>
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <input tabIndex={-1} autoComplete="off" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
      </div>

      <div>
        <label className="flex cursor-pointer items-start gap-3 text-base text-grape-900">
          <input type="checkbox" checked={rules} onChange={(e) => setRules(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-grape-700" />
          <span>Я ознакомился(ась) с правилами посещения{rulesDocs.length > 1 ? " и обязанностями сопровождающего" : ""}.</span>
        </label>
        {rulesDocs.map(docLink)}
        {err("acceptRules")}
      </div>
      <div>
        <label className="flex cursor-pointer items-start gap-3 text-base text-grape-900">
          <input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-grape-700" />
          <span>Я даю согласие на обработку моих персональных данных.</span>
        </label>
        {dataDoc ? docLink(dataDoc) : null}
        {err("acceptPersonalData")}
      </div>

      {status === "error" ? <p role="alert" className="text-sm font-semibold text-[#b3261e]">Не удалось сохранить регистрацию. Попробуйте ещё раз или обратитесь к администратору.</p> : null}
      <button type="submit" disabled={status === "submitting"} className={buttonClass("primary", "w-full disabled:opacity-60")}>
        {status === "submitting" ? "Сохраняем…" : "Зарегистрироваться"}
      </button>
    </form>
  );
}
