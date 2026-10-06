import Link from "next/link";
import type { ReactNode } from "react";
import { buttonClass, type Variant } from "./buttonStyles";

interface Props {
  href: string;
  variant?: Variant;
  external?: boolean;
  className?: string;
  /** Analytics hook: data-track="ClickRoute" is picked up by the global click tracker. */
  track?: string;
  children: ReactNode;
}

export function ButtonLink({ href, variant = "primary", external, className = "", track, children }: Props) {
  const cls = buttonClass(variant, className);
  const isExternal = external ?? /^https?:\/\//.test(href);
  if (isExternal) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls} data-track={track}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls} data-track={track}>
      {children}
    </Link>
  );
}
