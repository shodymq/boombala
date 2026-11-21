"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import { useMemo, useState, type ReactNode } from "react";

type Language = "ru" | "kk";

interface LegalLanguageSwitcherProps {
  ruMarkdown: string;
  kkMarkdown: string;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return "";
}

function safeHref(value: string): string | undefined {
  if ((value.startsWith("/") && !value.startsWith("//")) || value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sectionHeadings(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => /^###\s+(.+?)\s*$/.exec(line)?.[1]?.trim() ?? "")
    .filter(Boolean);
}

function sectionId(language: Language, heading: string, headings: string[]): string {
  const index = headings.indexOf(heading);
  return `legal-${language}-section-${Math.max(0, index) + 1}`;
}

export function LegalLanguageSwitcher({ ruMarkdown, kkMarkdown }: LegalLanguageSwitcherProps) {
  const [language, setLanguage] = useState<Language>("ru");
  const markdown = language === "ru" ? ruMarkdown : kkMarkdown;
  const headings = useMemo(() => sectionHeadings(markdown), [markdown]);

  const components: Components = {
    h1: ({ children }) => <h2 className="mt-8 font-display text-2xl font-black leading-tight text-grape-800 first:mt-0">{children}</h2>,
    h2: ({ children }) => <h2 className="mt-8 font-display text-2xl font-black leading-tight text-grape-800 first:mt-0">{children}</h2>,
    h3: ({ children }) => {
      const heading = nodeText(children);
      return (
        <h2 id={sectionId(language, heading, headings)} className="scroll-mt-24 mt-8 font-display text-xl font-black leading-tight text-grape-800 first:mt-0 sm:text-2xl">
          {children}
        </h2>
      );
    },
    p: ({ children }) => <p className="mt-4 text-base leading-relaxed text-grape-900 first:mt-0 md:text-lg">{children}</p>,
    ul: ({ children }) => <ul className="mt-4 list-disc space-y-2 pl-6 text-base leading-relaxed text-grape-900 md:text-lg">{children}</ul>,
    ol: ({ children }) => <ol className="mt-4 list-decimal space-y-2 pl-6 text-base leading-relaxed text-grape-900 md:text-lg">{children}</ol>,
    li: ({ children }) => <li className="pl-1">{children}</li>,
    em: ({ children }) => <em className="font-semibold not-italic text-grape-800">{children}</em>,
    strong: ({ children }) => <strong className="font-extrabold text-grape-800">{children}</strong>,
    a: ({ href, children }) => {
      const safe = href ? safeHref(href) : undefined;
      if (!safe) return <span>{children}</span>;
      const external = /^(?:https?:|mailto:)/.test(safe);
      return (
        <a href={safe} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined} className="font-semibold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-2 hover:text-grape-900">
          {children}
        </a>
      );
    },
  };

  return (
    <div className="mt-8">
      <div role="tablist" aria-label="Язык / Тіл" className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-grape-200 bg-white p-1">
        {([
          ["ru", "Русский"],
          ["kk", "Қазақша"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={language === value}
            className={`min-h-11 rounded-full px-5 font-display text-sm font-extrabold transition-colors ${language === value ? "bg-grape-700 text-white" : "text-grape-700 hover:bg-grape-50"}`}
            onClick={() => setLanguage(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {headings.length > 0 ? (
        <nav aria-label="Разделы документа" className="mt-5 overflow-x-auto rounded-2xl bg-grape-50 p-3">
          <p className="mb-2 text-xs font-extrabold uppercase tracking-[0.14em] text-grape-600">Разделы</p>
          <ol className="flex min-w-max gap-2 text-sm font-semibold text-grape-800">
            {headings.map((heading, index) => (
              <li key={`${language}-${index}`}>
                <a href={`#${sectionId(language, heading, headings)}`} className="inline-flex min-h-10 items-center rounded-full border border-grape-200 bg-white px-3 hover:bg-grape-100">
                  {index + 1}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <article lang={language} className="mt-7 rounded-3xl border border-grape-100 bg-white p-5 shadow-soft sm:p-8">
        <ReactMarkdown components={components} urlTransform={(url) => safeHref(url) ?? ""}>
          {markdown}
        </ReactMarkdown>
      </article>
    </div>
  );
}
