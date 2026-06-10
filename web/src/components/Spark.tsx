/** pure svg sparkline — fixed 0..100 domain so system gauges share a scale;
 *  colored entirely via currentColor (parent sets text-*). */
export default function Spark({
  series,
  width = 64,
  height = 18,
  className,
}: {
  series: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (series.length < 2) return null;
  const pad = 1; // half-stroke inset so 0/100 values don't clip
  const pts = series.map((v, i) => {
    const x = Math.round(((i / (series.length - 1)) * width) * 10) / 10;
    const clamped = Math.min(100, Math.max(0, v));
    const y = Math.round((pad + (1 - clamped / 100) * (height - pad * 2)) * 10) / 10;
    return `${x} ${y}`;
  });
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <path d={area} fill="currentColor" opacity={0.08} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
