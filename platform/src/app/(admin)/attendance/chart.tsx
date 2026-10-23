import type { SeriesDay } from "@/core/attendance";

/** Bar chart of children who came in per day: plain SVG, no library, readable without colour (values are printed). */
export function AttendanceChart({ series, selected }: { series: SeriesDay[]; selected: string }) {
  const W = 640;
  const H = 220;
  const padL = 34;
  const padB = 34;
  const padT = 16;
  const max = Math.max(1, ...series.map((d) => d.childrenEntered));
  const top = Math.ceil(max / 5) * 5 || 5;
  const plotW = W - padL - 8;
  const plotH = H - padT - padB;
  const step = plotW / Math.max(1, series.length);
  const barW = Math.max(6, step * 0.62);
  const summary = series.map((d) => `${d.date}: ${d.childrenEntered}`).join("; ");
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Дети, вошедшие по дням. ${summary}`} className="h-auto w-full">
        <title>Количество детей, фактически вошедших по дням</title>
        {[0, 0.5, 1].map((f) => {
          const y = padT + plotH - plotH * f;
          return (
            <g key={f}>
              <line x1={padL} x2={W - 8} y1={y} y2={y} stroke="currentColor" strokeOpacity="0.12" />
              <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="11" fill="currentColor" fillOpacity="0.6">{Math.round(top * f)}</text>
            </g>
          );
        })}
        {series.map((d, i) => {
          const h = (plotH * d.childrenEntered) / top;
          const x = padL + i * step + (step - barW) / 2;
          const y = padT + plotH - h;
          const isSel = d.date === selected;
          return (
            <g key={d.date}>
              <rect x={x} y={y} width={barW} height={Math.max(h, d.childrenEntered > 0 ? 1 : 0)} rx="3" className={isSel ? "fill-grape-700" : "fill-grape-300"} />
              {d.childrenEntered > 0 && series.length <= 16 ? <text x={x + barW / 2} y={y - 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="currentColor">{d.childrenEntered}</text> : null}
              {series.length <= 16 || i % 3 === 0 ? (
                <text x={x + barW / 2} y={H - padB + 15} textAnchor="middle" fontSize="10.5" fill="currentColor" fillOpacity={isSel ? 1 : 0.65} fontWeight={isSel ? 700 : 400}>
                  {d.date.slice(8, 10)}.{d.date.slice(5, 7)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">Столбцы показывают, сколько детей подтверждено на входе в каждый день.</figcaption>
    </figure>
  );
}
