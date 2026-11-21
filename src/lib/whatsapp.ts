import { getRoomName } from "@/data/birthdayRooms";
import { PACKAGE_OPTIONS } from "@/lib/lead";
import { siteConfig } from "@/services/config";

/**
 * WhatsApp chat link with an optional ready-made message. Nothing is sent automatically: WhatsApp opens
 * with the text typed in and the visitor presses "send" themselves.
 * Returns `null` when no WhatsApp number is configured.
 */
export function whatsappUrl(message?: string): string | null {
  const number = siteConfig.contacts.whatsapp;
  if (!number) return null;
  const base = `https://wa.me/${number}`;
  return message ? `${base}?text=${encodeURIComponent(message)}` : base;
}

/**
 * Message for a birthday enquiry. Package and room are included only when the visitor chose them:
 * no made-up values ("undecided" and an empty room are left out).
 */
export function birthdayMessage({ packageId, roomId, locale = "ru" }: { packageId?: string | null; roomId?: string | null; locale?: "ru" | "kk" }): string {
  const pkg = packageId && packageId !== "undecided" ? PACKAGE_OPTIONS.find((o) => o.value === packageId)?.label : undefined;
  const room = roomId ? getRoomName(roomId) : null;
  if (locale === "kk") {
    const parts = ["Сәлеметсіз бе! Boom Bala-дағы мереке туралы білгім келеді."];
    if (pkg) parts.push(`Пакет: ${pkg}.`);
    if (room) parts.push(`Бөлме: ${room}.`);
    return parts.join(" ");
  }
  const parts = ["Здравствуйте! Хочу узнать о празднике в Boom Bala."];
  if (pkg) parts.push(`Пакет: ${pkg}.`);
  if (room) parts.push(`Комната: ${room}.`);
  return parts.join(" ");
}
