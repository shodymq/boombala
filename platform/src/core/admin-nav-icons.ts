/** Valid icon names supported by the admin's Icon component. */
export type AdminNavIcon =
  | "bell"
  | "calendar"
  | "check"
  | "chevron-right"
  | "dashboard"
  | "download"
  | "heart"
  | "inbox"
  | "logout"
  | "menu"
  | "more"
  | "plus"
  | "search"
  | "settings"
  | "ticket"
  | "user"
  | "users";

const NAV_ICON_NAMES: Record<string, AdminNavIcon> = {
  "/": "dashboard",
  "/bookings": "calendar",
  "/requests": "inbox",
  "/attendance": "check",
  "/contacts": "users",
  "/news": "bell",
  "/export": "download",
  "/sheets-import": "calendar",
  "/legal": "check",
  "/retention": "heart",
  "/users": "user",
  "/audit": "more",
  "/account": "settings",
};

/** Always returns a supported icon so an owner-only route cannot break the shared navigation at render time. */
export function adminNavIcon(href: string): AdminNavIcon {
  return NAV_ICON_NAMES[href] ?? "more";
}
