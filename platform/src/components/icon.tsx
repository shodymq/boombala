import {
  Bell, CalendarDays, ChevronRight, CircleCheck, Download, EllipsisVertical, Heart, Inbox, LayoutGrid, LogOut, Menu, Phone, Plus, Search, Settings, Ticket, User, Users,
  type LucideIcon,
} from "lucide-react";

/**
 * Interface icons: Lucide (https://lucide.dev, ISC licence, see docs/crm-design-assets.md). Inline SVG that inherits the
 * text colour (`currentColor`) and carries no style attribute, so the Content-Security-Policy stays strict.
 */
const ICONS = {
  bell: Bell,
  calendar: CalendarDays,
  check: CircleCheck,
  "chevron-right": ChevronRight,
  dashboard: LayoutGrid,
  download: Download,
  heart: Heart,
  inbox: Inbox,
  logout: LogOut,
  menu: Menu,
  more: EllipsisVertical,
  phone: Phone,
  plus: Plus,
  search: Search,
  settings: Settings,
  ticket: Ticket,
  user: User,
  users: Users,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18, className = "" }: { name: IconName; size?: number; className?: string }) {
  const Glyph = ICONS[name];
  return <Glyph aria-hidden="true" focusable="false" width={size} height={size} strokeWidth={1.75} className={`ui-icon ${className}`.trim()} />;
}
