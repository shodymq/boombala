/** Brand decorations: rounded star and the three-petal "burst" from the logo. */

export function Star({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={className} style={style}>
      <polygon
        points="50,8 61,38 93,38 67,57 77,90 50,71 23,90 33,57 7,38 39,38"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Burst({ className = "" }: { className?: string }) {
  const petal = "M0 0 C -13 -26 -11 -58 0 -84 C 11 -58 13 -26 0 0 Z";
  return (
    <svg viewBox="-70 -100 140 110" aria-hidden="true" className={className}>
      <g fill="currentColor" stroke="currentColor" strokeWidth="6" strokeLinejoin="round">
        <path d={petal} transform="rotate(-42) scale(0.82)" />
        <path d={petal} />
        <path d={petal} transform="rotate(42) scale(0.82)" />
      </g>
    </svg>
  );
}

/** Wavy ground line. Fills downward with currentColor. */
export function Wave({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 1440 80" preserveAspectRatio="none" aria-hidden="true" className={`w-full ${className}`}>
      <path
        d="M0 38 C 110 6, 230 2, 350 30 S 590 78, 720 48 S 970 2, 1090 28 S 1330 72, 1440 30 L1440 80 L0 80 Z"
        fill="currentColor"
      />
    </svg>
  );
}
