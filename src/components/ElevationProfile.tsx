import { useMemo, useRef } from "react";
import type { ElevationSample } from "../engine";

const WIDTH = 640;
const HEIGHT = 132;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 20;
const PADDING_LEFT = 30;
const PADDING_RIGHT = 6;

type ElevationProfileProps = {
  samples: readonly ElevationSample[];
  hoverIndex: number | null;
  onHoverIndexChange: (index: number | null) => void;
};

const formatDistance = (meters: number): string =>
  meters >= 1_000 ? `${(meters / 1_000).toFixed(1)} km` : `${Math.round(meters)} m`;

/** Colour the trace by how hard the ground is working against you. */
const gradeColor = (grade: number): string => {
  const steepness = Math.abs(grade);
  if (steepness < 0.05) return "#5b93d6";
  if (steepness < 0.12) return "#4e9b74";
  if (steepness < 0.2) return "#c8973f";
  return "#c4693f";
};

export function ElevationProfile({ samples, hoverIndex, onHoverIndexChange }: ElevationProfileProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  const geometry = useMemo(() => {
    if (samples.length < 2) return undefined;
    const totalDistance = Math.max(1, samples[samples.length - 1].distanceMeters);
    const elevations = samples.map((sample) => sample.elevationMeters);
    const lowest = Math.min(...elevations);
    const highest = Math.max(...elevations);
    // Never let a 2 m rise fill the whole chart and look like a mountain.
    const span = Math.max(12, highest - lowest);
    const midpoint = (highest + lowest) / 2;
    const floor = midpoint - span / 2;

    const plotWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
    const plotHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;
    const x = (distance: number) => PADDING_LEFT + (distance / totalDistance) * plotWidth;
    const y = (elevation: number) =>
      PADDING_TOP + plotHeight - ((elevation - floor) / span) * plotHeight;

    const points = samples.map((sample) => ({
      x: x(sample.distanceMeters),
      y: y(sample.elevationMeters),
      sample,
    }));
    const area = `M ${points[0].x} ${PADDING_TOP + plotHeight} ` +
      points.map((point) => `L ${point.x} ${point.y}`).join(" ") +
      ` L ${points[points.length - 1].x} ${PADDING_TOP + plotHeight} Z`;

    const offTrailBands: Array<{ start: number; end: number }> = [];
    for (let index = 1; index < samples.length; index += 1) {
      if (!samples[index].mappedPath) {
        const start = x(samples[index - 1].distanceMeters);
        const end = x(samples[index].distanceMeters);
        const previous = offTrailBands[offTrailBands.length - 1];
        if (previous && Math.abs(previous.end - start) < 0.5) previous.end = end;
        else offTrailBands.push({ start, end });
      }
    }

    return { points, area, lowest, highest, floor, span, totalDistance, plotHeight, offTrailBands };
  }, [samples]);

  if (!geometry) {
    return <p className="profile-empty">No elevation profile for this route.</p>;
  }

  const { points, area, lowest, highest, totalDistance, plotHeight, offTrailBands } = geometry;
  const active = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : undefined;
  const baseline = PADDING_TOP + plotHeight;

  const handleMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const position = ratio * WIDTH;
    let closest = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < points.length; index += 1) {
      const distance = Math.abs(points[index].x - position);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = index;
      }
    }
    onHoverIndexChange(closest);
  };

  return (
    <div className="elevation-profile">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="elevation-profile-svg"
        role="img"
        aria-label={`Elevation profile, ${Math.round(lowest)} to ${Math.round(highest)} metres`}
        onMouseMove={handleMove}
        onMouseLeave={() => onHoverIndexChange(null)}
      >
        <defs>
          <linearGradient id="elevation-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8fb6d8" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#8fb6d8" stopOpacity="0.06" />
          </linearGradient>
        </defs>

        {[0, 0.5, 1].map((fraction) => {
          const y = PADDING_TOP + plotHeight * fraction;
          const value = highest - (highest - lowest) * fraction;
          return (
            <g key={fraction}>
              <line x1={PADDING_LEFT} y1={y} x2={WIDTH - PADDING_RIGHT} y2={y} className="profile-gridline" />
              <text x={PADDING_LEFT - 5} y={y + 3} className="profile-axis-label" textAnchor="end">
                {Math.round(value)}
              </text>
            </g>
          );
        })}

        {offTrailBands.map((band) => (
          <rect
            key={`${band.start}-${band.end}`}
            x={band.start}
            y={baseline - 3}
            width={Math.max(1, band.end - band.start)}
            height={3}
            className="profile-offtrail-band"
          />
        ))}

        <path d={area} fill="url(#elevation-fill)" />

        {points.slice(1).map((point, index) => (
          <line
            key={index}
            x1={points[index].x}
            y1={points[index].y}
            x2={point.x}
            y2={point.y}
            stroke={gradeColor(point.sample.grade)}
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        ))}

        {active && (
          <g>
            <line x1={active.x} y1={PADDING_TOP} x2={active.x} y2={baseline} className="profile-cursor" />
            <circle cx={active.x} cy={active.y} r={3.4} className="profile-cursor-dot" />
          </g>
        )}

        <text x={PADDING_LEFT} y={HEIGHT - 5} className="profile-axis-label">0</text>
        <text x={WIDTH - PADDING_RIGHT} y={HEIGHT - 5} className="profile-axis-label" textAnchor="end">
          {formatDistance(totalDistance)}
        </text>
      </svg>

      <div className="profile-readout">
        {active ? (
          <>
            <span><strong>{Math.round(active.sample.elevationMeters)} m</strong> elevation</span>
            <span><strong>{formatDistance(active.sample.distanceMeters)}</strong> in</span>
            <span><strong>{(active.sample.grade * 100).toFixed(1)}%</strong> grade</span>
            <span className={active.sample.mappedPath ? "profile-tag-mapped" : "profile-tag-offtrail"}>
              {active.sample.mappedPath ? "On a mapped way" : "Off-trail"}
            </span>
          </>
        ) : (
          <span className="profile-hint">
            Hover the profile to read elevation and grade, and to locate the point on the map.
          </span>
        )}
      </div>
    </div>
  );
}
