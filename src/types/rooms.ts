export interface RoomPhoto {
  src: string;
  alt: string;
  width: number;
  height: number;
}

export interface BirthdayRoom {
  /** Stable id, also the value sent to the API. */
  id: string;
  /** Official name shown on the site and in Telegram. */
  name: string;
  coverImage: RoomPhoto;
  /** Includes the cover as the first element. */
  images: RoomPhoto[];
  /** Web-optimised horizontal video. Absent until a real clip is supplied. */
  video?: string;
  videoPoster?: RoomPhoto;
}
