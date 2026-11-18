"use client";

import type { ReactNode } from "react";
import { useLeadForm } from "./LeadFormProvider";
import { buttonClass, type Variant } from "@/components/ui/buttonStyles";
import type { LeadPackage } from "@/lib/lead";
import type { Locale } from "@/types";

/** Opens the lead form. Looks exactly like ButtonLink; semantically a button. */
export function LeadButton({
  variant = "primary",
  className = "",
  package: pkg,
  source,
  locale,
  children,
}: {
  variant?: Variant;
  className?: string;
  package?: LeadPackage;
  source?: string;
  locale?: Locale;
  children: ReactNode;
}) {
  const { open } = useLeadForm();
  return (
    <button type="button" onClick={() => open({ package: pkg, source, locale })} className={buttonClass(variant, className)}>
      {children}
    </button>
  );
}
