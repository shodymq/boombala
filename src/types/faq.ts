export interface FaqItem {
  id: string;
  question: string;
  /** A plain string, or one text per opening phase (before 7 Oct 12:00 / until 24 Oct 10:00 / after). */
  answer: string | { before: string; working: string; open: string };
}
