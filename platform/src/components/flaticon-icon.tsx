import Image from "next/image";

export type FlaticonIconName =
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

export function FlaticonIcon({ name, size = 18, className = "" }: {
  name: FlaticonIconName;
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src={`/icons/flaticon/${name}.png`}
      alt=""
      aria-hidden="true"
      className={`flaticon-icon ${className}`}
      width={size}
      height={size}
      draggable={false}
    />
  );
}
