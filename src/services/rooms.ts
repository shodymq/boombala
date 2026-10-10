import { birthdayRooms } from "@/data/birthdayRooms";
import type { BirthdayRoom } from "@/types";
import { resolve } from "./http";

/** GET /birthday-rooms */
export function getBirthdayRooms(): Promise<BirthdayRoom[]> {
  return resolve("/birthday-rooms", () => birthdayRooms);
}
