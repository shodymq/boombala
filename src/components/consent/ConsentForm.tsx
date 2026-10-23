"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { formatNationalPhone, phoneDigits } from "@/lib/lead";
import { buttonClass } from "@/components/ui/buttonStyles";

interface Doc {
  kind: string;
  version: number;
  title: string;
  body: string;
}

const field =
  "h-12 w-full rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink transition-colors placeholder:text-muted/70 focus:border-grape-600 focus:outline-none disabled:bg-grape-50 aria-[invalid=true]:border-lava-500";

function newKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Status = "idle" | "submitting" | "success" | "error" | "rate" | "changed";

/**
 * Name, optional phone, the full texts of the documents with their editions, an acknowledgement of the rules and a SEPARATE
 * consent to personal data processing. Nothing else. Texts, titles and editions come from the platform: a new approved
 * document needs no change here. The editions the visitor saw are sent along; if another edition has been published since,
 * nothing is recorded, the ticks are removed and the new texts are shown.
 */
export function ConsentForm({ documents }: { documents: Doc[] }) {
  const uid = useId();
  const router = useRouter();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // A tick belongs to the editions it was given for: when the documents change, the ticks stop counting by themselves.
  const sig = documents.map((d) => `${d.kind}:${d.version}`).join("|");
  const [rulesSig, setRulesSig] = useState<string | null>(null);
  const [dataSig, setDataSig] = useState<string | null>(null);
  const rules = rulesSig === sig;
  const data = dataSig === sig;
  const stale = (rulesSig !== null && rulesSig !== sig) || (dataSig !== null && dataSig !== sig);
  const [honeypot, setHoneypot] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>("idle");
  const [savedDocs, setSavedDocs] = useState<Doc[]>([]);
  const inFlight = useRef(false);
  const key = useRef<string | null>(null);
  const rulesDocs = documents.filter((d) => d.kind !== "personal_data_consent");
  const dataDoc = documents.find((d) => d.kind === "personal_data_consent");
  const busy = status === "submitting";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Synchronous guard against a double tap: state updates are async.
    if (inFlight.current || status === "success") return;
    const next: Record<string, string> = {};
    const national = phoneDigits(phone);
    if (name.trim().length < 2) next.name = "Укажите имя";
    if (national.length > 0 && national.length !== 10) next.phone = "Введите 10 цифр после +7 или оставьте поле пустым";
    if (!rules) next.acceptRules = "Подтвердите, что ознакомились с правилами";
    if (!data) next.acceptPersonalData = "Необходимо согласие на обработку данных";
    setErrors(next);
    if (Object.keys(next).length) {
      // Move to the first problem so it is not hidden below the fold on a phone.
      setTimeout(() => document.querySelector<HTMLElement>("[data-consent-invalid=true]")?.focus(), 0);
      return;
    }

    inFlight.current = true;
    setStatus("submitting");
    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          ...(national ? { phone: `+7${national}` } : {}),
          acceptRules: true,
          acceptPersonalData: true,
          website: honeypot,
          documentVersions: Object.fromEntries(documents.map((d) => [d.kind, d.version])),
          idempotencyKey: (key.current ??= newKey()),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok === true) {
        setSavedDocs(documents);
        return setStatus("success");
      }
      if (res.status === 409 && body.error === "documents_changed") {
        setStatus("changed");
        router.refresh();
        return;
      }
      if (res.status === 400 && body.fieldErrors) {
        setErrors(body.fieldErrors);
        return setStatus("idle");
      }
      setStatus(res.status === 429 ? "rate" : "error");
    } catch {
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  }

  if (status === "success") {
    return (
      <div role="status" className="mt-6 grid gap-3 text-grape-900">
        <p className="font-display text-2xl font-black text-grape-800">Регистрация сохранена</p>
        <p className="text-base leading-relaxed">
          Спасибо{name.trim() ? `, ${name.trim()}` : ""}. Мы записали ваше ознакомление и согласие от вашего имени. Страницу можно закрыть.
        </p>
        <ul className="grid gap-1 rounded-2xl bg-grape-50 px-4 py-3 text-sm">
          {savedDocs.map((d) => (
            <li key={d.kind}>
              {d.title} <span className="text-muted">(редакция {d.version})</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">Это не бронирование и не отметка о посещении.</p>
      </div>
    );
  }

  const err = (k: string) => (errors[k] ? <p id={`${uid}-${k}-err`} className="mt-1.5 text-sm font-semibold text-[#b3261e]">{errors[k]}</p> : null);
  const inv = (k: string) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `${uid}-${k}-err`, "data-consent-invalid": true } : {});
  const docCard = (d: Doc) => (
    <details key={d.kind} className="rounded-2xl border border-grape-200 bg-white" data-doc-kind={d.kind}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span className="font-display text-sm font-extrabold text-grape-800">{d.title}</span>
        <span className="shrink-0 rounded-full bg-grape-50 px-3 py-1 text-xs font-bold text-grape-700">редакция {d.version}</span>
      </summary>
      <div tabIndex={0} role="region" aria-label={`${d.title}, полный текст`} className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-grape-100 px-4 py-3 text-sm leading-relaxed text-grape-900">
        {d.body}
      </div>
    </details>
  );
  const heading = (n: string, label: string) => (
    <h2 className="flex items-center gap-3 font-display text-lg font-black text-grape-800">
      <span aria-hidden="true" className="rounded-full bg-grape-100 px-2.5 py-0.5 text-xs font-black text-grape-600">{n}</span>
      {label}
    </h2>
  );

  return (
    <form onSubmit={onSubmit} noValidate aria-busy={busy} className="mt-6 grid gap-6">
      <fieldset disabled={busy} className="grid gap-6 border-0 p-0">
        <section className="grid gap-4" aria-label="Ваши данные">
          {heading("01", "Ваши данные")}
          <div className="grid gap-2">
            <label htmlFor={`${uid}-name`} className="font-display text-sm font-extrabold text-grape-800">
              Ваше имя <span className="font-normal text-muted">(взрослый сопровождающий)</span>
            </label>
            <input id={`${uid}-name`} name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className={field} {...inv("name")} />
            {err("name")}
          </div>
          <div className="grid gap-2">
            <label htmlFor={`${uid}-phone`} className="font-display text-sm font-extrabold text-grape-800">
              Телефон для экстренной связи <span className="font-normal text-muted">(необязательно)</span>
            </label>
            <div className="relative">
              <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base font-semibold text-grape-800">+7</span>
              <input id={`${uid}-phone`} name="phone" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="707 123 45 67" value={phone} onChange={(e) => setPhone(formatNationalPhone(phoneDigits(e.target.value, true)))} className={`${field} pl-11`} {...inv("phone")} />
            </div>
            {err("phone")}
          </div>
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <input tabIndex={-1} autoComplete="off" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
          </div>
        </section>

        <section className="grid gap-3" aria-label="Документы">
          {heading("02", "Документы")}
          <p className="text-sm text-muted">Откройте документ, чтобы прочитать полный текст. Редакция указана рядом с названием.</p>
          {[...rulesDocs, ...(dataDoc ? [dataDoc] : [])].map(docCard)}
        </section>

        <section className="grid gap-4" aria-label="Подтверждения">
          {heading("03", "Подтверждения")}
          {stale ? (
            <p role="alert" className="rounded-2xl border border-sun-300 bg-sun-100 px-4 py-3 text-sm font-semibold text-grape-900">
              Документы были обновлены, ваши подтверждения сняты. Прочитайте новую редакцию и подтвердите заново.
            </p>
          ) : null}
          <div>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-base text-grape-900">
              <input type="checkbox" name="acceptRules" checked={rules} onChange={(e) => setRulesSig(e.target.checked ? sig : null)} className="mt-0.5 h-6 w-6 shrink-0 accent-grape-700" {...inv("acceptRules")} />
              <span>Я ознакомился(ась) с правилами посещения{rulesDocs.length > 1 ? " и обязанностями сопровождающего" : ""}.</span>
            </label>
            {err("acceptRules")}
          </div>
          <div>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 text-base text-grape-900">
              <input type="checkbox" name="acceptPersonalData" checked={data} onChange={(e) => setDataSig(e.target.checked ? sig : null)} className="mt-0.5 h-6 w-6 shrink-0 accent-grape-700" {...inv("acceptPersonalData")} />
              <span>Я даю согласие на обработку моих персональных данных.</span>
            </label>
            {err("acceptPersonalData")}
          </div>
        </section>
      </fieldset>

      <div aria-live="polite" className="grid gap-2">
        {status === "error" ? (
          <p role="alert" className="text-sm font-semibold text-[#b3261e]">
            Не удалось сохранить регистрацию. Введённое не потеряно: нажмите «Попробовать снова». Повторная отправка не создаст дубль.
          </p>
        ) : null}
        {status === "rate" ? <p role="alert" className="text-sm font-semibold text-[#b3261e]">Слишком много попыток. Подождите немного и нажмите «Попробовать снова».</p> : null}
        {status === "changed" ? <p role="alert" className="text-sm font-semibold text-grape-900">Документы были обновлены. Обновляем тексты: прочитайте новую редакцию и подтвердите заново.</p> : null}
      </div>
      <button type="submit" disabled={busy} className={buttonClass("primary", "w-full disabled:opacity-60")}>
        {busy ? "Сохраняем…" : status === "error" || status === "rate" ? "Попробовать снова" : "Зарегистрироваться"}
      </button>
    </form>
  );
}
