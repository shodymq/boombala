export interface Promotion {
  id: string;
  title: string;
  description: string;
}

export interface EventItem {
  id: string;
  title: string;
  /** ISO date. */
  date: string;
  description: string;
}
