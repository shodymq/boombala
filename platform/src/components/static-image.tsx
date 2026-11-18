/**
 * Plain <img> for the small brand icons and illustrations in /public. next/image would add an inline style attribute
 * (`color: transparent`), which the Content-Security-Policy (no 'unsafe-inline' for styles, see proxy.ts) blocks, and
 * these files are already optimized: there is nothing for the image optimizer to do.
 */
export function StaticImage({ src, alt, width, height, className, draggable }: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  draggable?: boolean;
}) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} width={width} height={height} className={className} draggable={draggable} decoding="async" />;
}
