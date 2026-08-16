import {
  LocateFixed,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  Waves,
  X,
} from "lucide-react";
import type { MapPoint, PlacementMode, RouteResult } from "./pathless-types";

type MapCanvasProps = {
  route: RouteResult;
  start: MapPoint;
  target: MapPoint;
  waypoints: MapPoint[];
  placementMode: PlacementMode;
  onMapClick: (point: MapPoint) => void;
  onPlacementModeChange: (mode: Exclude<PlacementMode, null>) => void;
  onClearWaypoint: (index: number) => void;
};

const terrainLabels = [
  { label: "Pine shelf", x: 19, y: 24, tone: "green" },
  { label: "Birch hollow", x: 62, y: 18, tone: "slate" },
  { label: "Unmapped land", x: 68, y: 72, tone: "orange" },
  { label: "North ridge", x: 29, y: 78, tone: "blue" },
] as const;

function pathD(points: MapPoint[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function MapCanvas({
  route,
  start,
  target,
  waypoints,
  placementMode,
  onMapClick,
  onPlacementModeChange,
  onClearWaypoint,
}: MapCanvasProps) {
  function handleSurfaceClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!placementMode) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    onMapClick({
      x: clamp(((event.clientX - bounds.left) / bounds.width) * 100, 4, 96),
      y: clamp(((event.clientY - bounds.top) / bounds.height) * 100, 6, 94),
    });
  }

  return (
    <section className="map-workspace" aria-label="Route map workspace">
      <div className="map-header">
        <div>
          <div className="eyebrow">Route workspace</div>
          <h1>North ridge traverse</h1>
        </div>
        <div className="map-header-actions">
          <span className="map-status">
            <span className="status-dot status-dot-green" />
            Live terrain model
          </span>
          <button className="icon-button map-header-icon" type="button" aria-label="Reset map view" title="Reset map view">
            <RotateCcw size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div
        className={`map-surface ${placementMode ? "map-surface-placement" : ""}`}
        onClick={handleSurfaceClick}
        role="application"
        aria-label="Interactive terrain map. Choose a placement tool, then click anywhere on the map."
      >
        <div className="map-grid map-grid-horizontal" />
        <div className="map-grid map-grid-vertical" />

        <svg className="terrain-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="map-wash" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#f8faf7" />
              <stop offset="0.55" stopColor="#f4f6f3" />
              <stop offset="1" stopColor="#eef2ef" />
            </linearGradient>
            <linearGradient id="ridge-wash" x1="0" y1="0" x2="0.8" y2="1">
              <stop offset="0" stopColor="#dfe9df" stopOpacity="0.75" />
              <stop offset="1" stopColor="#f4f6f3" stopOpacity="0" />
            </linearGradient>
            <filter id="route-shadow" x="-10%" y="-10%" width="120%" height="120%">
              <feDropShadow dx="0" dy="0.6" stdDeviation="0.7" floodColor="#214b87" floodOpacity="0.22" />
            </filter>
          </defs>

          <rect width="100" height="100" fill="url(#map-wash)" />
          <path d="M -5 72 C 13 61, 17 77, 30 65 S 54 49, 67 64 S 88 71, 106 57 L 106 106 L -5 106 Z" fill="url(#ridge-wash)" />
          <path d="M -4 38 C 9 29, 17 42, 30 31 S 52 13, 66 30 S 87 38, 106 21" fill="none" stroke="#d8e2d7" strokeWidth="1.2" opacity="0.9" />
          <path d="M -4 42 C 10 33, 18 46, 30 35 S 52 17, 66 34 S 87 42, 106 25" fill="none" stroke="#e2e9e1" strokeWidth="0.7" />
          <path d="M -3 55 C 12 45, 19 59, 31 49 S 50 31, 64 46 S 89 56, 104 41" fill="none" stroke="#d4ded4" strokeWidth="0.95" />
          <path d="M -3 59 C 12 49, 20 63, 32 53 S 51 35, 65 50 S 90 60, 104 45" fill="none" stroke="#e0e7df" strokeWidth="0.65" />
          <path d="M -1 75 C 10 66, 21 77, 33 70 S 53 51, 68 67 S 89 76, 102 64" fill="none" stroke="#cbd9cc" strokeWidth="0.9" />
          <path d="M 7 8 C 14 16, 19 21, 23 32 S 31 47, 42 52 S 54 69, 64 91" fill="none" stroke="#bdccd3" strokeWidth="1.15" opacity="0.78" />
          <path d="M 9 5 C 16 14, 21 20, 25 31 S 33 44, 44 50 S 56 68, 67 95" fill="none" stroke="#e9eeef" strokeWidth="0.75" />
          <path d="M 84 -4 C 78 10, 79 19, 86 27 S 93 45, 81 55 S 75 74, 84 104" fill="none" stroke="#c3d2c7" strokeWidth="1.05" opacity="0.8" />
          <path d="M 89 -4 C 83 10, 84 18, 91 26 S 98 44, 86 54 S 80 73, 89 104" fill="none" stroke="#e3eae5" strokeWidth="0.75" />

          <path d="M -5 86 C 10 80, 13 91, 25 84 S 45 72, 58 82 S 76 92, 105 82" fill="none" stroke="#c8d6c9" strokeWidth="0.85" />
          <path d="M -2 91 C 13 85, 16 96, 28 89 S 46 77, 60 87 S 77 97, 104 87" fill="none" stroke="#dce5dc" strokeWidth="0.65" />
          <path d="M 39 -2 C 44 12, 39 24, 47 35 S 54 48, 49 61 S 51 82, 57 102" fill="none" stroke="#dae3dd" strokeWidth="0.75" />

          <path d="M 22 9 C 30 4, 35 8, 39 15 C 42 21, 38 27, 31 29 C 24 30, 18 23, 18 17 C 18 13, 19 11, 22 9 Z" fill="#e6efe5" opacity="0.9" />
          <path d="M 68 60 C 73 54, 83 55, 88 61 C 93 68, 88 77, 80 78 C 72 78, 65 71, 68 60 Z" fill="#f5ecd9" opacity="0.48" />
          <path d="M 12 51 C 18 46, 26 49, 27 57 C 27 65, 20 70, 14 66 C 8 63, 7 56, 12 51 Z" fill="#ecf2e9" opacity="0.8" />

          <path d={pathD(route.alternatives[0] ?? [])} fill="none" stroke="#9ca9b2" strokeWidth="1.6" strokeDasharray="2.2 2.2" opacity="0.62" />
          <path d={pathD(route.alternatives[1] ?? [])} fill="none" stroke="#b7a987" strokeWidth="1.35" strokeDasharray="1.6 2.4" opacity="0.68" />
          <path d={pathD(route.routePath)} fill="none" stroke="#ffffff" strokeWidth="3.8" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" filter="url(#route-shadow)" />
          <path d={pathD(route.routePath)} fill="none" stroke="#2f6fc4" strokeWidth="2.15" strokeLinecap="round" strokeLinejoin="round" />
          <path d={pathD(route.routePath)} fill="none" stroke="#79a9e5" strokeWidth="0.65" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
        </svg>

        <div className="map-label map-label-pine"><span className="map-label-dot map-label-dot-green" />Pine shelf</div>
        <div className="map-label map-label-ridge"><span className="map-label-dot map-label-dot-blue" />North ridge</div>
        <div className="map-label map-label-hollow"><span className="map-label-dot map-label-dot-slate" />Birch hollow</div>
        <div className="map-label map-label-unmapped"><span className="map-label-dot map-label-dot-orange" />Unmapped land</div>
        <div className="water-label"><Waves size={12} />Seasonal creek</div>

        <div className="map-marker map-marker-start" style={{ left: `${start.x}%`, top: `${start.y}%` }} title="Start point">
          <span className="marker-pulse" />
          <span className="marker-core marker-core-start" />
          <span className="marker-caption">Start</span>
        </div>
        {waypoints.map((waypoint, index) => (
          <div
            className="map-marker map-marker-waypoint"
            key={`${waypoint.x}-${waypoint.y}-${index}`}
            style={{ left: `${waypoint.x}%`, top: `${waypoint.y}%` }}
            title={`Waypoint ${index + 1}`}
          >
            <span className="waypoint-core">{index + 1}</span>
            <button
              className="waypoint-remove"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onClearWaypoint(index);
              }}
              aria-label={`Remove waypoint ${index + 1}`}
            >
              <X size={10} />
            </button>
          </div>
        ))}
        <div className="map-marker map-marker-target" style={{ left: `${target.x}%`, top: `${target.y}%` }} title="Target point">
          <span className="marker-core marker-core-target"><Sparkles size={12} /></span>
          <span className="marker-caption">Target</span>
        </div>

        <div className="map-placement-hint">
          {placementMode ? (
            <>
              <span className="status-dot status-dot-blue" />
              Click the map to place {placementMode === "waypoint" ? "a waypoint" : placementMode}
            </>
          ) : (
            <>
              <span className="status-dot status-dot-slate" />
              Select a point tool to update the route
            </>
          )}
        </div>

        <div className="map-place-tools" onClick={(event) => event.stopPropagation()}>
          <button
            className={`map-place-button ${placementMode === "start" ? "map-place-button-active" : ""}`}
            type="button"
            onClick={() => onPlacementModeChange("start")}
          >
            <span className="place-dot place-dot-start" />
            Start
          </button>
          <button
            className={`map-place-button ${placementMode === "target" ? "map-place-button-active" : ""}`}
            type="button"
            onClick={() => onPlacementModeChange("target")}
          >
            <span className="place-dot place-dot-target" />
            Target
          </button>
          <button
            className={`map-place-button ${placementMode === "waypoint" ? "map-place-button-active" : ""}`}
            type="button"
            onClick={() => onPlacementModeChange("waypoint")}
          >
            <span className="place-dot place-dot-waypoint">+</span>
            Waypoint
          </button>
        </div>

        <div className="map-controls" onClick={(event) => event.stopPropagation()}>
          <button className="map-control-button" type="button" aria-label="Zoom in" title="Zoom in">
            <Plus size={15} />
          </button>
          <button className="map-control-button" type="button" aria-label="Zoom out" title="Zoom out">
            <Minus size={15} />
          </button>
          <span className="map-control-divider" />
          <button className="map-control-button" type="button" aria-label="Locate route" title="Locate route">
            <LocateFixed size={15} />
          </button>
        </div>

        <div className="map-scale" aria-label="Map scale">500 m</div>

        <div className="terrain-chip-row" onClick={(event) => event.stopPropagation()}>
          {terrainLabels.map((item) => (
            <span className={`terrain-chip terrain-chip-${item.tone}`} key={item.label} style={{ left: `${item.x}%`, top: `${item.y}%` }}>
              {item.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

