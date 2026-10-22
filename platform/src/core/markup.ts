/**
 * Restricted markup for news bodies. The text is parsed into a small block tree and rendered by React elements:
 * raw HTML is never produced, stored or injected. Anything that is not recognised stays plain text.
 *
 *   ## Heading        ### Subheading
 *   paragraph (a single line break stays a line break; a blank line starts a new paragraph)
 *   - list item       * list item
 *   ![](img:<image id>)      an uploaded picture (its alt text comes from the upload)
 *   **bold**   [text](https://example.com)   [text](/birthdays)   [text](tel:+77471234567)
 */
export type Inline = { t: "text"; v: string } | { t: "strong"; v: string } | { t: "link"; href: string; v: string } | { t: "br" };
export type Block =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; inlines: Inline[] }
  | { type: "ul"; items: Inline[][] }
  | { type: "img"; imageId: string };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IMG_LINE = new RegExp(`^!\\[[^\\]]{0,200}\\]\\(img:(${UUID})\\)$`, "i");

/** Only these destinations become links; `javascript:`, `data:`, protocol-relative `//` and everything else are dropped. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s<>"']{1,500}$/i.test(href)) return href;
  if (/^\/(?!\/)[^\s<>"']{0,500}$/.test(href)) return href;
  if (/^tel:\+?[0-9]{5,15}$/.test(href)) return href;
  return null;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: "br" });
    const re = /\*\*([^*\n]{1,300})\*\*|\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g;
    let last = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (m.index > last) out.push({ t: "text", v: line.slice(last, m.index) });
      if (m[1] !== undefined) out.push({ t: "strong", v: m[1] });
      else {
        const href = safeHref(m[3]);
        out.push(href ? { t: "link", href, v: m[2] } : { t: "text", v: m[2] });
      }
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push({ t: "text", v: line.slice(last) });
  });
  return out;
}

export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  const chunks = body.replace(/\r\n?/g, "\n").trim().split(/\n{2,}/);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((l) => l.trimEnd());
    if (!lines.join("").trim()) continue;
    let paragraph: string[] = [];
    let list: Inline[][] = [];
    const flushP = () => {
      if (paragraph.length) blocks.push({ type: "p", inlines: parseInline(paragraph.join("\n")) });
      paragraph = [];
    };
    const flushL = () => {
      if (list.length) blocks.push({ type: "ul", items: list });
      list = [];
    };
    for (const line of lines) {
      const h3 = /^###\s+(.{1,200})$/.exec(line);
      const h2 = /^##\s+(.{1,200})$/.exec(line);
      const li = /^[-*]\s+(.{1,500})$/.exec(line);
      const img = IMG_LINE.exec(line.trim());
      if (h3 || h2 || img) {
        flushP();
        flushL();
        if (img) blocks.push({ type: "img", imageId: img[1].toLowerCase() });
        else blocks.push({ type: h3 ? "h3" : "h2", text: (h3 ?? h2)![1].trim() });
      } else if (li) {
        flushP();
        list.push(parseInline(li[1]));
      } else {
        flushL();
        paragraph.push(line);
      }
    }
    flushP();
    flushL();
  }
  return blocks;
}

/** Ids of the uploaded pictures a body refers to. */
export function imageIdsIn(body: string): string[] {
  return [...new Set(parseBody(body).flatMap((b) => (b.type === "img" ? [b.imageId] : [])))];
}

/** Plain text for search snippets and meta descriptions. */
export function plainText(body: string, max = 200): string {
  const text = parseBody(body)
    .flatMap((b) => (b.type === "p" ? [b.inlines.map((i) => (i.t === "br" ? " " : i.v)).join("")] : b.type === "ul" ? b.items.map((it) => it.map((i) => (i.t === "br" ? " " : i.v)).join("")) : b.type === "h2" || b.type === "h3" ? [b.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
