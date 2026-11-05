import "server-only";

import { fetchPublishedDocuments, type PlatformDocument } from "@/lib/platform";

export type PublicLegalKind = "visit_rules" | "personal_data_consent";

export interface LegalLanguageBodies {
  ru: string;
  kk: string;
}

/** The CRM stores both languages in one Markdown body. */
export function splitLegalLanguages(body: string): LegalLanguageBodies {
  const lines = body.replace(/\r\n?/g, "\n").trim().split("\n");
  const ruHeading = lines.findIndex((line) => /^##\s+Русская версия\s*$/i.test(line.trim()));
  const kkHeading = lines.findIndex((line) => /^##\s+Қазақша нұсқа\s*$/i.test(line.trim()));

  if (ruHeading >= 0 && kkHeading > ruHeading) {
    return {
      ru: lines.slice(ruHeading + 1, kkHeading).join("\n").trim(),
      kk: lines.slice(kkHeading + 1).join("\n").trim(),
    };
  }

  // Older approved consent text used a horizontal rule instead of language headings.
  const separator = lines.findIndex((line) => /^---+\s*$/.test(line.trim()));
  if (separator > 0) {
    return {
      ru: lines.slice(0, separator).join("\n").trim(),
      kk: lines.slice(separator + 1).join("\n").trim(),
    };
  }

  return { ru: body.trim(), kk: body.trim() };
}

/** Fetches only the currently published document from the protected CRM API. */
export async function getPublishedLegalDocument(kind: PublicLegalKind): Promise<PlatformDocument | null> {
  try {
    const documents = await fetchPublishedDocuments();
    return documents.find((document) => document.kind === kind) ?? null;
  } catch {
    return null;
  }
}
