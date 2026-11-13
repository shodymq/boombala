"use client";

import { useState } from "react";
import { changeOwnPasswordAction } from "./actions";

const input = "h-12 rounded-2xl border-2 border-grape-200 bg-white px-4 text-base text-ink focus:border-grape-600 focus:outline-none";

const fields = [
  { name: "current", label: "Текущий пароль", autoComplete: "current-password" },
  { name: "next", label: "Новый пароль", autoComplete: "new-password", minLength: 12 },
  { name: "repeat", label: "Подтверждение нового пароля", autoComplete: "new-password", minLength: 12 },
] as const;

export function PasswordFields() {
  const [visible, setVisible] = useState(false);

  return (
    <form action={changeOwnPasswordAction} className="grid gap-3 rounded-3xl border border-line bg-white p-5">
      {fields.map((field) => (
        <input
          key={field.name}
          name={field.name}
          type={visible ? "text" : "password"}
          placeholder={field.label}
          required
          autoComplete={field.autoComplete}
          minLength={"minLength" in field ? field.minLength : undefined}
          maxLength={128}
          className={input}
          aria-label={field.label}
        />
      ))}
      <button
        type="button"
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
        className="h-11 justify-self-start rounded-full border-2 border-grape-700 px-4 text-sm font-extrabold text-grape-700 hover:bg-grape-50"
      >
        {visible ? "Скрыть пароли" : "Показать пароли"}
      </button>
      <button type="submit" className="h-12 rounded-full bg-grape-700 text-base font-extrabold text-white hover:bg-grape-600">Сменить пароль</button>
    </form>
  );
}
