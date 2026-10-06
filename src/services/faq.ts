import { faqItems } from "@/data/faq";
import type { FaqItem } from "@/types";

export async function getFaq(): Promise<FaqItem[]> {
  return faqItems;
}
