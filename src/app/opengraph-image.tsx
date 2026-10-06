import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const alt = "Boom Bala — детский развлекательный центр в Алматы";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const mascot = await readFile(path.join(process.cwd(), "src/app/og-mascot.png"));
  const src = `data:image/png;base64,${mascot.toString("base64")}`;
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: "#fbf9ff", position: "relative" }}>
        <div style={{ position: "absolute", right: 0, top: 0, width: 520, height: 630, background: "#4d1ba3" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 70px", width: 700 }}>
          <div style={{ fontSize: 120, fontWeight: 900, color: "#3b1485", lineHeight: 1 }}>BOOM</div>
          <div style={{ fontSize: 120, fontWeight: 900, color: "#ffc60a", lineHeight: 1, marginTop: 4 }}>BALA</div>
          <div style={{ fontSize: 38, color: "#5c5075", marginTop: 36 }}>ALMATY · 07.10.2026</div>
        </div>
        <img src={src} alt="" width={420} height={560} style={{ position: "absolute", right: 60, bottom: 0, objectFit: "contain" }} />
      </div>
    ),
    size,
  );
}
