import type { BirthdayRoom, RoomPhoto } from "@/types";

/**
 * Themed rooms for birthdays. Single source of truth: the gallery UI, the lead form select and the
 * server-side validation of `room` all read from this array.
 *
 * One photo per room. These four images were enhanced with AI by the owner's team, so they are NOT
 * documentary-accurate: some details may differ from the real room. The UI says so; keep it that way.
 * Capacity, "included in the price" and booking conditions are NOT confirmed: never state them here.
 *
 * Names are official (confirmed by the owner). The wall prints are only the decoration:
 * Ice Room = "Лайк Настя / Ледниковый период", Magic Room = "Корпорация монстров".
 */

const photo = (file: string, alt: string, width: number, height: number): RoomPhoto => ({
  src: `/rooms/${file}`,
  alt,
  width,
  height,
});

const roblox = photo("roblox.webp", "Roblox Room: комната с тематическими стенами Roblox, длинный стол и стулья", 1448, 1086);
const ice = photo("ice.webp", "Ice Room: комната с тематическими стенами, длинный стол и стулья", 1536, 1024);
const magic = photo("magic.webp", "Magic Room: комната с тематическими стенами, длинный стол и жёлтый диван", 1536, 1024);
const rapunzel = photo("rapunzel.webp", "Rapunzel Room: комната с тематической стеной, длинный стол и красные кресла", 1672, 941);

export const birthdayRooms: BirthdayRoom[] = [
  { id: "roblox-room", name: "Roblox Room", coverImage: roblox, images: [roblox] },
  { id: "ice-room", name: "Ice Room", coverImage: ice, images: [ice] },
  { id: "magic-room", name: "Magic Room", coverImage: magic, images: [magic] },
  { id: "rapunzel-room", name: "Rapunzel Room", coverImage: rapunzel, images: [rapunzel] },
];

export type RoomId = (typeof birthdayRooms)[number]["id"];

/** Allowed values for the API and the form select. */
export const ROOM_IDS: readonly string[] = birthdayRooms.map((r) => r.id);

export const getRoomName = (id: string): string | null => birthdayRooms.find((r) => r.id === id)?.name ?? null;

/** One note under the rooms section: the images are AI-enhanced, not documentary. */
export const ROOM_PHOTO_NOTE = "Изображения интерьеров созданы на основе фотографий. Отдельные детали могут отличаться.";
