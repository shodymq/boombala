"use client";

import { WhatsappLogo } from "@phosphor-icons/react";
import { useSelectedPackage } from "@/components/lead/SelectedPackage";
import { buttonClass } from "@/components/ui/buttonStyles";
import { Container } from "@/components/ui/Container";
import { birthdayMessage, whatsappUrl } from "@/lib/whatsapp";
import { siteConfig } from "@/services/config";
import type { Locale } from "@/types";
import { BIRTHDAYS_UI } from "@/data/birthdays-ui";

/**
 * Alternative to the booking form (the form and its Telegram delivery stay as they are).
 * WhatsApp opens with a ready message that names the package and room chosen during this visit, if any.
 * A click here is NOT a lead and is not counted as one.
 */
export function WhatsAppCta({ locale }: { locale: Locale }) {
  const ui = BIRTHDAYS_UI[locale];
  const { selected, room } = useSelectedPackage();
  const href = whatsappUrl(birthdayMessage({ packageId: selected, roomId: room, locale }));
  if (!href) return null;
  const { phone } = siteConfig.contacts;
  return (
    <section aria-labelledby="whatsapp-title" className="py-10 md:py-14">
      <Container>
        <div className="flex flex-col gap-5 rounded-[2rem] bg-grape-50 p-6 sm:flex-row sm:items-center sm:justify-between md:p-8">
          <div>
            <h2 id="whatsapp-title" className="font-display text-xl font-black tracking-tight text-grape-800 md:text-2xl">
              {ui.whatsappTitle}
            </h2>
            <p className="mt-1 max-w-[44ch] text-base leading-relaxed text-muted">{ui.whatsappBody}</p>
            <a
              href={`tel:${phone.tel}`}
              className="mt-2 inline-flex min-h-11 items-center font-display text-base font-extrabold text-grape-700 underline decoration-sun-400 decoration-2 underline-offset-4"
            >
              {ui.whatsappCall} {phone.display}
            </a>
          </div>
          <a href={href} target="_blank" rel="noopener noreferrer" className={buttonClass("primary", "w-full shrink-0 sm:w-auto")}>
            <WhatsappLogo size={22} weight="bold" aria-hidden="true" />
            {ui.whatsappButton}
          </a>
        </div>
      </Container>
    </section>
  );
}
