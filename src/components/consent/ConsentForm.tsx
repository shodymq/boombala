"use client";

import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatNationalPhone, phoneDigits } from "@/lib/lead";
import { buttonClass } from "@/components/ui/buttonStyles";

interface Doc {
  kind: string;
  version: number;
  title: string;
  body: string;
}

type Lang = "ru" | "kk";

const MAX_KIDS = 50;
const stepBtn =
  "flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-grape-300 bg-white font-display text-3xl font-black leading-none text-grape-800 transition-colors hover:bg-grape-50 active:bg-grape-100 disabled:cursor-not-allowed disabled:opacity-40";

const field =
  "h-12 w-full rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink transition-colors placeholder:text-muted/70 focus:border-grape-600 focus:outline-none disabled:bg-grape-50 aria-[invalid=true]:border-lava-500";

/** Every visible string of the page, in the two languages. The full legal texts come from the platform (one document, both languages). */
const T = {
  ru: {
    title: "Регистрация сопровождающего",
    subtitle: "Заполните форму перед посещением центра. Это займёт меньше минуты.",
    group: "Данные сопровождающего",
    name: "Ваше имя",
    nameHint: "Без онлайн-регистрации можно ознакомиться с правилами у кассира",
    phone: "Телефон",
    phoneOpt: "(по желанию)",
    phoneHint: "Для экстренной связи",
    kids: "Сколько детей с вами?",
    kidsHint: "Укажите только количество детей",
    less: "Уменьшить количество детей",
    more: "Увеличить количество детей",
    docsGroup: "Документы и подтверждения",
    rules: "С Правилами посещения ознакомлен(а)",
    readRules: "Читать правила",
    data: "Даю согласие на обработку персональных данных",
    readData: "Читать согласие и Политику ПДн",
    policy: "Политика обработки персональных данных",
    edition: "редакция",
    fullText: "полный текст",
    stale: "Документы были обновлены, ваши подтверждения сняты. Прочитайте новую редакцию и подтвердите заново.",
    submit: "Зарегистрироваться",
    busy: "Сохраняем…",
    retry: "Попробовать снова",
    error: "Не удалось сохранить регистрацию. Введённое не потеряно: нажмите «Попробовать снова». Повторная отправка не создаст дубль.",
    rate: "Слишком много попыток. Подождите немного и нажмите «Попробовать снова».",
    changed: "Документы были обновлены. Обновляем тексты: прочитайте новую редакцию и подтвердите заново.",
    foot: "Это не бронирование: регистрация не означает посещение.",
    errs: {
      name: "Укажите имя",
      phone: "Введите 10 цифр после +7 или оставьте поле пустым",
      kids: `Укажите от 1 до ${MAX_KIDS} детей`,
      rules: "Подтвердите, что ознакомились с правилами",
      data: "Необходимо согласие на обработку данных",
    },
    ok: "Регистрация сохранена",
    thanks: (n: string) => `Спасибо${n ? `, ${n}` : ""}. Мы записали ваше ознакомление и согласие от вашего имени. Страницу можно закрыть.`,
    withYou: "Детей с вами:",
    adminConfirms: "Количество фактически вошедших подтверждает администратор на входе.",
    notVisit: "Это не бронирование и не отметка о посещении.",
    docLabel: { visit_rules: "Правила посещения", companion_duties: "Обязанности сопровождающего", personal_data_consent: "Согласие на обработку персональных данных" } as Record<string, string>,
  },
  kk: {
    title: "Еріп жүрушіні тіркеу",
    subtitle: "Орталыққа келер алдында нысанды толтырыңыз. Бір минуттан аз уақыт алады.",
    group: "Еріп жүрушінің деректері",
    name: "Атыңыз",
    nameHint: "Онлайн-тіркеусіз Қағидалармен касса қызметкерінен танысуға болады",
    phone: "Телефон",
    phoneOpt: "(қалауыңызша)",
    phoneHint: "Шұғыл байланыс үшін",
    kids: "Сізбен бірге нешеу бала?",
    kidsHint: "Тек балалар санын көрсетіңіз",
    less: "Балалар санын азайту",
    more: "Балалар санын көбейту",
    docsGroup: "Құжаттар және растаулар",
    rules: "Келу қағидаларымен таныстым",
    readRules: "Қағидаларды оқу",
    data: "Дербес деректерді өңдеуге келісім беремін",
    readData: "Келісім мен Саясатты оқу",
    policy: "Дербес деректерді өңдеу саясаты",
    edition: "нұсқа",
    fullText: "толық мәтін",
    stale: "Құжаттар жаңартылды, растауларыңыз алынып тасталды. Жаңа нұсқаны оқып, қайта растаңыз.",
    submit: "Тіркелу",
    busy: "Сақталуда…",
    retry: "Қайталап көру",
    error: "Тіркеу сақталмады. Енгізгеніңіз жоғалған жоқ: «Қайталап көру» түймесін басыңыз. Қайта жіберу телнұсқа жасамайды.",
    rate: "Әрекет тым көп. Біраз күтіп, «Қайталап көру» түймесін басыңыз.",
    changed: "Құжаттар жаңартылды. Мәтіндер жаңартылуда: жаңа нұсқаны оқып, қайта растаңыз.",
    foot: "Бұл брондау емес: тіркелу келуді білдірмейді.",
    errs: {
      name: "Атыңызды көрсетіңіз",
      phone: "+7-ден кейін 10 сан енгізіңіз немесе өрісті бос қалдырыңыз",
      kids: `1-ден ${MAX_KIDS}-ге дейін бала санын көрсетіңіз`,
      rules: "Қағидалармен танысқаныңызды растаңыз",
      data: "Дербес деректерді өңдеуге келісім қажет",
    },
    ok: "Тіркеу сақталды",
    thanks: (n: string) => `Рақмет${n ? `, ${n}` : ""}. Қағидалармен танысқаныңыз бен келісіміңіз сіздің атыңыздан жазылды. Бетті жабуға болады.`,
    withYou: "Сізбен бірге балалар:",
    adminConfirms: "Нақты кірген балалар санын кіреберісте әкімші растайды.",
    notVisit: "Бұл брондау емес және келуді белгілеу емес.",
    docLabel: { visit_rules: "Келу қағидалары", companion_duties: "Еріп жүрушінің міндеттері", personal_data_consent: "Дербес деректерді өңдеуге келісім" } as Record<string, string>,
  },
} as const;

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
 * Name, optional phone, number of children, an acknowledgement of the rules and a SEPARATE consent to personal data processing.
 * The short labels are for the main screen; the full texts of the documents with their editions open in place (and stay available
 * until the visitor confirms). Texts, titles and editions come from the platform: a new approved document needs no change here.
 * The editions the visitor saw are sent along; if another edition has been published since, nothing is recorded, the ticks are
 * removed and the new texts are shown. The language switch only changes labels: typed data and ticks are kept.
 */
export function ConsentForm({ documents }: { documents: Doc[] }) {
  const uid = useId();
  const router = useRouter();
  const [lang, setLang] = useState<Lang>("ru");
  const t = T[lang];
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [kids, setKids] = useState("1");
  // A tick belongs to the editions it was given for: when the documents change, the ticks stop counting by themselves.
  const sig = documents.map((d) => `${d.kind}:${d.version}`).join("|");
  const [rulesSig, setRulesSig] = useState<string | null>(null);
  const [dataSig, setDataSig] = useState<string | null>(null);
  const rules = rulesSig === sig;
  const data = dataSig === sig;
  const stale = (rulesSig !== null && rulesSig !== sig) || (dataSig !== null && dataSig !== sig);
  const [honeypot, setHoneypot] = useState("");
  // Client-side problems are kept as codes (translated when drawn); anything else is a text from the server.
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Status>("idle");
  const [savedDocs, setSavedDocs] = useState<Doc[]>([]);
  const [savedKids, setSavedKids] = useState(1);
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
    if (name.trim().length < 2) next.name = "name";
    if (national.length > 0 && national.length !== 10) next.phone = "phone";
    const kidsNumber = /^\d{1,2}$/.test(kids) ? Number(kids) : NaN;
    if (!(kidsNumber >= 1 && kidsNumber <= MAX_KIDS)) next.childrenCount = "kids";
    if (!rules) next.acceptRules = "rules";
    if (!data) next.acceptPersonalData = "data";
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
          childrenCount: Number(kids),
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
        setSavedKids(Number(kids));
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

  const switcher = (
    <div role="group" aria-label="Язык / Тіл" className="flex justify-end">
      <div className="inline-flex rounded-full border-2 border-grape-200 bg-white p-0.5 text-sm font-extrabold">
        {(["ru", "kk"] as const).map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
            className={`min-h-11 min-w-14 rounded-full px-3 transition-colors ${lang === l ? "bg-grape-700 text-white" : "text-grape-800 hover:bg-grape-50"}`}
          >
            {l === "ru" ? "RU" : "ҚАЗ"}
          </button>
        ))}
      </div>
    </div>
  );

  const header = (
    <header lang={lang}>
      <h1 id="consent-title" className="font-display text-[1.75rem] font-black leading-tight tracking-tight text-grape-800 sm:text-3xl">
        {t.title}
      </h1>
      <p className="mt-2 text-base leading-relaxed text-muted">{t.subtitle}</p>
    </header>
  );

  if (status === "success") {
    return (
      <div lang={lang}>
        {switcher}
        <div role="status" className="mt-2 grid gap-3 rounded-3xl border border-grape-100 bg-white p-5 text-grape-900 shadow-soft sm:p-7">
          <p className="font-display text-2xl font-black text-grape-800">{t.ok}</p>
          <p className="text-base leading-relaxed">{t.thanks(name.trim())}</p>
          <ul className="grid gap-1 rounded-2xl bg-grape-50 px-4 py-3 text-sm">
            {savedDocs.map((d) => (
              <li key={d.kind}>
                {t.docLabel[d.kind] ?? d.title} <span className="text-muted">({t.edition} {d.version})</span>
              </li>
            ))}
          </ul>
          <p className="text-sm">{t.withYou} <b>{savedKids}</b>. {t.adminConfirms}</p>
          <p className="text-sm text-muted">{t.notVisit}</p>
        </div>
      </div>
    );
  }

  const errText = (k: string) => {
    const v = errors[k];
    if (!v) return "";
    return (t.errs as Record<string, string>)[v] ?? v;
  };
  const err = (k: string) => (errors[k] ? <p id={`${uid}-${k}-err`} className="mt-1.5 text-sm font-semibold text-[#b3261e]">{errText(k)}</p> : null);
  const inv = (k: string) => (errors[k] ? { "aria-invalid": true as const, "aria-describedby": `${uid}-${k}-err`, "data-consent-invalid": true } : {});
  const docLabel = (d: Doc) => t.docLabel[d.kind] ?? d.title;
  // A compact, collapsible row: the full text of the edition the visitor sees (and consents to) opens in place.
  const docCard = (d: Doc, summary: string, extra?: ReactNode) => (
    <details key={d.kind} className="rounded-xl border border-grape-200 bg-white" data-doc-kind={d.kind}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
        <span className="font-bold text-grape-800 underline decoration-grape-300 underline-offset-4">{summary}</span>
        <span className="shrink-0 rounded-full bg-grape-50 px-2.5 py-0.5 text-xs font-bold text-grape-700">{t.edition} {d.version}</span>
      </summary>
      <div tabIndex={0} role="region" aria-label={`${docLabel(d)}, ${t.fullText}`} className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-grape-100 px-3 py-3 text-sm leading-relaxed text-grape-900">
        {d.body}
      </div>
      {extra}
    </details>
  );

  return (
    <div lang={lang}>
      {switcher}
      <div className="mt-1">{header}</div>
      <div className="mt-5 rounded-3xl border border-grape-100 bg-white p-5 shadow-soft sm:p-7">
        <form onSubmit={onSubmit} noValidate aria-busy={busy} className="grid gap-5">
          <fieldset disabled={busy} className="grid gap-5 border-0 p-0">
            <div className="grid gap-5" role="group" aria-label={t.group}>
              <div className="grid gap-1.5">
                <label htmlFor={`${uid}-name`} className="font-display text-sm font-extrabold text-grape-800">
                  {t.name} <span aria-hidden="true">*</span>
                </label>
                <input id={`${uid}-name`} name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} aria-describedby={`${uid}-name-hint`} className={field} {...inv("name")} />
                <p id={`${uid}-name-hint`} className="text-xs leading-relaxed text-muted" data-testid="alt-ack">{t.nameHint}</p>
                {err("name")}
              </div>
              <div className="grid gap-1.5">
                <label htmlFor={`${uid}-phone`} className="font-display text-sm font-extrabold text-grape-800">
                  {t.phone} <span className="font-normal text-muted">{t.phoneOpt}</span>
                </label>
                <div className="relative">
                  <span aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-base font-semibold text-grape-800">+7</span>
                  <input id={`${uid}-phone`} name="phone" type="tel" aria-describedby={`${uid}-phone-hint`} inputMode="tel" autoComplete="tel-national" placeholder="707 123 45 67" value={phone} onChange={(e) => setPhone(formatNationalPhone(phoneDigits(e.target.value, true)))} className={`${field} pl-11`} {...inv("phone")} />
                </div>
                <p id={`${uid}-phone-hint`} className="text-xs leading-relaxed text-muted">{t.phoneHint}</p>
                {err("phone")}
              </div>
              <div role="group" aria-labelledby={`${uid}-kids-label`} className="grid gap-1.5">
                <span id={`${uid}-kids-label`} className="font-display text-sm font-extrabold text-grape-800">{t.kids}</span>
                <div className="flex items-center gap-3">
                  <button type="button" aria-label={t.less} disabled={!(Number(kids) > 1)} onClick={() => setKids(String(Math.max(1, (Number(kids) || 1) - 1)))} className={stepBtn}>
                    −
                  </button>
                  <input
                    name="childrenCount"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    maxLength={2}
                    aria-labelledby={`${uid}-kids-label`}
                    aria-describedby={`${uid}-kids-hint`}
                    value={kids}
                    onChange={(e) => setKids(e.target.value.replace(/\D/g, "").slice(0, 2))}
                    onBlur={() => setKids(String(Math.min(MAX_KIDS, Math.max(1, Number(kids) || 1))))}
                    className="h-14 w-20 rounded-2xl border-2 border-grape-200 bg-white text-center font-display text-2xl font-black text-grape-800 focus:border-grape-600 focus:outline-none aria-[invalid=true]:border-lava-500"
                    {...inv("childrenCount")}
                  />
                  <button type="button" aria-label={t.more} disabled={!(Number(kids) < MAX_KIDS)} onClick={() => setKids(String(Math.min(MAX_KIDS, (Number(kids) || 0) + 1)))} className={stepBtn}>
                    +
                  </button>
                </div>
                <p id={`${uid}-kids-hint`} className="text-xs leading-relaxed text-muted">{t.kidsHint}</p>
                {err("childrenCount")}
              </div>
              <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
                <input tabIndex={-1} autoComplete="off" name="website" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
              </div>
            </div>

            <div className="grid gap-3 border-t border-grape-100 pt-4" role="group" aria-label={t.docsGroup}>
              {stale ? (
                <p role="alert" className="rounded-2xl border border-sun-300 bg-sun-100 px-4 py-3 text-sm font-semibold text-grape-900">{t.stale}</p>
              ) : null}
              <div>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base text-grape-900">
                  <input type="checkbox" name="acceptRules" checked={rules} onChange={(e) => setRulesSig(e.target.checked ? sig : null)} className="h-6 w-6 shrink-0 accent-grape-700" {...inv("acceptRules")} />
                  <span>{t.rules}</span>
                </label>
                <div className="ml-9 grid gap-2">{rulesDocs.map((d) => docCard(d, rulesDocs.length > 1 ? docLabel(d) : t.readRules))}</div>
                {err("acceptRules")}
              </div>
              <div>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base text-grape-900">
                  <input type="checkbox" name="acceptPersonalData" checked={data} onChange={(e) => setDataSig(e.target.checked ? sig : null)} className="h-6 w-6 shrink-0 accent-grape-700" {...inv("acceptPersonalData")} />
                  <span>{t.data}</span>
                </label>
                {dataDoc ? (
                  <div className="ml-9 grid gap-2">
                    {docCard(
                      dataDoc,
                      t.readData,
                      <p className="border-t border-grape-100 px-3 py-2 text-sm">
                        <a href="/privacy" target="_blank" rel="noopener" className="inline-flex min-h-11 items-center font-semibold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2">{t.policy}</a>
                      </p>,
                    )}
                  </div>
                ) : null}
                {err("acceptPersonalData")}
              </div>
            </div>
          </fieldset>

          <div aria-live="polite" className="grid gap-2">
            {status === "error" ? <p role="alert" className="text-sm font-semibold text-[#b3261e]">{t.error}</p> : null}
            {status === "rate" ? <p role="alert" className="text-sm font-semibold text-[#b3261e]">{t.rate}</p> : null}
            {status === "changed" ? <p role="alert" className="text-sm font-semibold text-grape-900">{t.changed}</p> : null}
          </div>
          <button type="submit" disabled={busy} className={buttonClass("primary", "w-full disabled:opacity-60")}>
            {busy ? t.busy : status === "error" || status === "rate" ? t.retry : t.submit}
          </button>
        </form>
      </div>
      <p className="mt-4 text-center text-xs leading-relaxed text-muted">{t.foot}</p>
    </div>
  );
}
