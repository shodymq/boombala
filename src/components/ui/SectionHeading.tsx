import type { ReactNode } from "react";

export function SectionHeading({
  eyebrow,
  title,
  children,
  className = "",
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={className}>
      <p className="mb-3 inline-flex items-center gap-2 font-display text-sm font-extrabold uppercase tracking-[0.14em] text-grape-600">
        <span aria-hidden="true" className="h-[3px] w-6 rounded-full bg-sun-400" />
        {eyebrow}
      </p>
      <h2 className="font-display text-[2rem] font-black leading-[1.05] tracking-tight text-grape-800 sm:text-5xl lg:text-[3.5rem]">
        {title}
      </h2>
      {children ? <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-muted md:text-lg">{children}</p> : null}
    </header>
  );
}
