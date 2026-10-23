/**
 * Non-collecting presentation of the registration page until the operator's approved legal documents and a permitted intake
 * service are available. Same hierarchy as the working form (name, phone, number of children, two confirmations, one button).
 *
 * Deliberately has NO interactive form, no input names and no network requests.
 * In particular, it must never generate a false "consent saved" confirmation.
 */
export function ConsentDraftPreview() {
  const box = "h-12 w-full rounded-2xl border-2 border-grape-200 bg-grape-50 px-4 text-base text-muted disabled:cursor-not-allowed";
  return (
    <section aria-label="Регистрация пока недоступна" className="mt-5">
      <div role="status" className="rounded-2xl border border-sun-300 bg-sun-100 px-4 py-3 text-sm leading-relaxed text-grape-900">
        <p className="font-display font-extrabold">Электронная регистрация пока недоступна</p>
        <p className="mt-1">Документы готовятся к публикации. До этого обратитесь к администратору на входе.</p>
      </div>

      <div className="mt-4 grid gap-5 rounded-3xl border border-grape-100 bg-white p-5 shadow-soft sm:p-7">
        <div>
          <label htmlFor="consent-preview-name" className="block text-sm font-extrabold text-grape-800">Имя сопровождающего</label>
          <input id="consent-preview-name" type="text" disabled placeholder="Имя" className={`mt-2 ${box}`} />
        </div>
        <div>
          <label htmlFor="consent-preview-phone" className="block text-sm font-extrabold text-grape-800">
            Телефон <span className="font-normal text-muted">(необязательно)</span>
          </label>
          <input id="consent-preview-phone" type="tel" disabled placeholder="+7 ___ ___ __ __" className={`mt-2 ${box}`} />
        </div>
        <div>
          <p className="text-sm font-extrabold text-grape-800">Сколько детей с вами?</p>
          <div className="mt-2 flex items-center gap-3" aria-hidden="true">
            <span className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-grape-200 text-3xl font-black text-grape-300">−</span>
            <span className="flex h-14 w-20 items-center justify-center rounded-2xl border-2 border-grape-100 bg-grape-50 text-2xl font-black text-muted">1</span>
            <span className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-grape-200 text-3xl font-black text-grape-300">+</span>
          </div>
        </div>
        <div className="grid gap-3 border-t border-grape-100 pt-5">
          <label className="flex items-start gap-3 text-base text-grape-900">
            <input type="checkbox" disabled className="mt-0.5 h-6 w-6 shrink-0 accent-grape-700" />
            <span>Я ознакомился(ась) с правилами посещения.</span>
          </label>
          <label className="flex items-start gap-3 text-base text-grape-900">
            <input type="checkbox" disabled className="mt-0.5 h-6 w-6 shrink-0 accent-grape-700" />
            <span>Я даю согласие на обработку моих персональных данных.</span>
          </label>
        </div>
        <button type="button" disabled className="min-h-12 w-full cursor-not-allowed rounded-2xl bg-grape-200 px-5 py-3 font-display font-black text-grape-800">
          Регистрация пока недоступна
        </button>
        <p className="text-center text-xs text-muted">Оператор персональных данных: ИП Аманов</p>
      </div>
    </section>
  );
}
