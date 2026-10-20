"use client";

/** Shown when a page or an action fails (for example the database is unreachable). Fixed text: no message, stack or code from the server. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md content-center gap-4 px-4 text-center">
      <h1 className="text-2xl font-black text-grape-800">Сервис временно недоступен</h1>
      <p className="text-base text-muted">Что-то пошло не так на нашей стороне. Ваши данные не потеряны. Подождите минуту и попробуйте ещё раз.</p>
      <button type="button" onClick={reset} className="mx-auto h-11 rounded-full bg-grape-700 px-6 text-sm font-extrabold text-white hover:bg-grape-600">
        Повторить
      </button>
    </main>
  );
}
