/**
 * Non-collecting presentation of the QR registration until the operator's approved
 * legal documents and a permitted intake service are available.
 *
 * Deliberately has NO interactive form, no input names and no network requests.
 * In particular, it must never generate a false "consent saved" confirmation.
 */
export function ConsentDraftPreview() {
  return (
    <section aria-label="Предпросмотр QR-регистрации" className="mt-8">
      <div role="status" className="rounded-2xl border border-sun-300 bg-sun-100 px-4 py-4 text-sm leading-relaxed text-grape-900">
        <p className="font-display font-extrabold">Документы готовятся к публикации</p>
        <p className="mt-1">
          Электронная регистрация пока не принимает данные. После утверждения правил и политики
          здесь появится действующая форма. До этого обратитесь к администратору на входе.
        </p>
      </div>

      <div className="mt-5 rounded-3xl border border-grape-100 bg-white p-5 shadow-soft sm:p-7">
        <p className="font-display text-lg font-black text-grape-800">Данные сопровождающего</p>
        <div className="mt-5 grid gap-5">
          <div>
            <label htmlFor="consent-preview-name" className="block text-sm font-extrabold text-grape-800">
              Ваше имя
            </label>
            <input
              id="consent-preview-name"
              type="text"
              disabled
              placeholder="Имя сопровождающего"
              className="mt-2 h-12 w-full rounded-2xl border-2 border-grape-200 bg-grape-50 px-4 text-base text-muted disabled:cursor-not-allowed"
            />
          </div>
          <div>
            <label htmlFor="consent-preview-phone" className="block text-sm font-extrabold text-grape-800">
              Телефон для экстренной связи <span className="font-normal text-muted">(необязательно)</span>
            </label>
            <input
              id="consent-preview-phone"
              type="tel"
              disabled
              placeholder="+7 ___ ___ __ __"
              className="mt-2 h-12 w-full rounded-2xl border-2 border-grape-200 bg-grape-50 px-4 text-base text-muted disabled:cursor-not-allowed"
            />
          </div>
        </div>

        <div className="my-6 h-px bg-grape-100" />

        <h2 className="font-display text-lg font-black text-grape-800">Ознакомление и подтверждения</h2>
        <div className="mt-4 grid gap-4">
          <div className="rounded-2xl border border-grape-100 bg-grape-50 p-4">
            <label className="flex items-start gap-3 text-base text-grape-900">
              <input type="checkbox" disabled className="mt-1 h-5 w-5 shrink-0 accent-grape-700" />
              <span>Я ознакомился(ась) с правилами посещения.</span>
            </label>
            <p className="ml-8 mt-2 text-sm text-muted">Текст правил появится после юридического утверждения.</p>
          </div>
          <div className="rounded-2xl border border-grape-100 bg-grape-50 p-4">
            <label className="flex items-start gap-3 text-base text-grape-900">
              <input type="checkbox" disabled className="mt-1 h-5 w-5 shrink-0 accent-grape-700" />
              <span>Я даю отдельное согласие на обработку моих персональных данных.</span>
            </label>
            <p className="ml-8 mt-2 text-sm text-muted">Полный текст согласия появится после юридического утверждения.</p>
          </div>
        </div>
        <button type="button" disabled className="mt-6 min-h-12 w-full cursor-not-allowed rounded-2xl bg-grape-200 px-5 py-3 font-display font-black text-grape-800">
          Регистрация пока недоступна
        </button>
        <p className="mt-3 text-center text-xs leading-relaxed text-muted">
          На этой странице сейчас ничего не отправляется и не сохраняется.
        </p>
      </div>
    </section>
  );
}
