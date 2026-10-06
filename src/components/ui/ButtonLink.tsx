import Link from "next/link";
import type { ReactNode } from "react";

type Variant = "primary" | "accent" | "outline";

const base =
  "group inline-flex h-14 select-none items-center justify-center gap-2 whitespace-nowrap rounded-full px-7 font-display text-base font-extrabold leading-none transition-[transform,box-shadow,background-color,color] duration-150 ease-out active:translate-y-[3px] md:text-[1.0625rem]";

const variants: Record<Variant, string> = {
  primary:
    "bg-grape-700 text-white shadow-[0_5px_0_0_var(--color-grape-900)] hover:bg-grape-600 active:shadow-[0_2px_0_0_var(--color-grape-900)]",
  accent:
    "bg-sun-400 text-grape-900 shadow-[0_5px_0_0_#b98600] hover:bg-sun-300 active:shadow-[0_2px_0_0_#b98600]",
  outline:
    "border-2 border-grape-700 bg-white text-grape-700 shadow-[0_5px_0_0_var(--color-grape-200)] hover:bg-grape-50 active:shadow-[0_2px_0_0_var(--color-grape-200)]",
};

interface Props {
  href: string;
  variant?: Variant;
  external?: boolean;
  className?: string;
  children: ReactNode;
}

export function ButtonLink({ href, variant = "primary", external, className = "", children }: Props) {
  const cls = `${base} ${variants[variant]} ${className}`;
  const isExternal = external ?? /^https?:\/\//.test(href);
  if (isExternal) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}
