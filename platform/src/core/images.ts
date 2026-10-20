import { createHash } from "node:crypto";
import sharp from "sharp";
import { ValidationError } from "./errors.ts";

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 1600;

export interface ProcessedImage {
  data: Buffer;
  mime: "image/webp";
  width: number;
  height: number;
  sha256: Buffer;
}

/** The real type comes from the bytes, never from the file name or the browser's Content-Type. */
function sniff(buf: Buffer): "jpeg" | "png" | "webp" | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/**
 * Accepts JPEG, PNG or WebP only (no SVG, no GIF, no documents). The picture is decoded and re-encoded: EXIF/GPS, camera
 * and author data, embedded profiles and anything hidden in the file are dropped, the orientation is applied, the size is capped.
 * What reaches the database and the public site is only pixels.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length === 0) throw new ValidationError({ file: "Выберите файл" });
  if (input.length > MAX_UPLOAD_BYTES) throw new ValidationError({ file: "Файл больше 4 МБ" });
  if (!sniff(input)) throw new ValidationError({ file: "Допустимы только JPEG, PNG и WebP" });
  try {
    const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, failOn: "error" })
      .rotate() // applies EXIF orientation, then the metadata is not carried over
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    if (info.width < 16 || info.height < 16) throw new ValidationError({ file: "Изображение слишком маленькое" });
    return { data, mime: "image/webp", width: info.width, height: info.height, sha256: createHash("sha256").update(data).digest() };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError({ file: "Не удалось прочитать изображение" });
  }
}
