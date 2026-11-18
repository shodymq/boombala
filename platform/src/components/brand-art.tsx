/**
 * Own decorative artwork (three balloons and confetti, drawn for this project with plain shapes in the brand colours).
 * It replaces third-party illustrations whose licence could not be shown. Inline SVG, no style attributes (CSP-safe).
 */
export function BrandArt({ size = 56, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" fill="none" role="img" aria-label="" aria-hidden="true" focusable="false">
      <path d="M22 34 C24 44 28 50 34 58" stroke="#3b1e78" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M32 31 C32 42 33 50 34 58" stroke="#3b1e78" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M43 35 C42 44 38 51 34 58" stroke="#3b1e78" strokeWidth="1.5" strokeLinecap="round" />
      <ellipse cx="21" cy="22" rx="10" ry="12" fill="#8a6cba" />
      <ellipse cx="32" cy="19" rx="10" ry="12.5" fill="#3b1e78" />
      <ellipse cx="44" cy="23" rx="9" ry="11.5" fill="#f4b740" />
      <ellipse cx="17.5" cy="17" rx="2.5" ry="4" fill="#ffffff" fillOpacity="0.35" />
      <ellipse cx="28.5" cy="13.5" rx="2.5" ry="4" fill="#ffffff" fillOpacity="0.3" />
      <ellipse cx="40.5" cy="18" rx="2.2" ry="3.6" fill="#ffffff" fillOpacity="0.4" />
      <circle cx="8" cy="40" r="2" fill="#f4b740" />
      <circle cx="55" cy="44" r="2" fill="#8a6cba" />
      <rect x="11" y="50" width="4" height="4" rx="1" fill="#3b1e78" transform="rotate(20 13 52)" />
    </svg>
  );
}
