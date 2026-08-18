import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Clock3,
  Download,
  PanelBottomClose,
  PanelBottomOpen,
  Route as RouteIcon,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { SURFACE_LABELS, type OSMRoute, type SurfaceClass } from "../engine";
import { ElevationProfile } from "./ElevationProfile";
import type { ElevationStatus, RouteView } from "./pathless-types";

type RouteSummaryProps = {
  view: RouteView;
  isCalculating: boolean;
  isHidden: boolean;
  elevationStatus: ElevationStatus;
  hoverIndex: number | null;
  onHoverIndexChange: (index: number | null) => void;
  onHiddenChange: (hidden: boolean) => void;
  onSelectAlternative: (index: number) => void;
  onDownload: (format: "gpx" | "geojson") => void;
};

const SURFACE_COLORS: Record<SurfaceClass, string> = {
  paved: "#4c83c4",
  gravel: "#7f96a6",
  "natural-trail": "#5e9c72",
  steps: "#c07f45",
  "open-terrain": "#c9a75a",
};

const formatDuration = (minutes: number): string => {
  const rounded = Math.max(1, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  return hours > 0 ? `${hours} h ${rounded % 60} min` : `${rounded} min`;
};

const formatDistance = (meters: number): string =>
  meters >= 1_000 ? `${(meters / 1_000).toFixed(2)} km` : `${Math.round(meters)} m`;

export function RouteSummary({
  view,
  isCalculating,
  isHidden,
  elevationStatus,
  hoverIndex,
  onHoverIndexChange,
  onHiddenChange,
  onSelectAlternative,
  onDownload,
}: RouteSummaryProps) {
  const [showDetails, setShowDetails] = useState(false);
  const route = view.route;

  if (isHidden) {
    return (
      <button
        className="route-summary-collapsed"
        type="button"
        aria-label="Show route details"
        aria-expanded="false"
        onClick={() => onHiddenChange(false)}
      >
        <PanelBottomOpen size={14} />
        <span>Route details</span>
        <small>{route ? formatDistance(route.distanceMeters) : "No route"}</small>
      </button>
    );
  }

  return (
    <aside className="route-summary" aria-label="Route details">
      <div className="summary-header">
        <div className="summary-title">
          <div className="eyebrow">{view.status === "blocked" ? "Route blocked" : route?.objectiveLabel}</div>
          <h2>{view.title}</h2>
          <p>{view.subtitle}</p>
        </div>
        <button
          className="summary-hide-button"
          type="button"
          aria-label="Hide route details"
          title="Hide route details"
          onClick={() => onHiddenChange(true)}
        >
          <PanelBottomClose size={14} />
        </button>
      </div>

      {route ? (
        <>
          <div className="summary-metrics">
            <div className="summary-metric">
              <span className="metric-icon metric-icon-blue"><RouteIcon size={13} /></span>
              <span className="metric-label">Distance</span>
              <strong>{formatDistance(route.distanceMeters)}</strong>
            </div>
            <div className="summary-metric">
              <span className="metric-icon metric-icon-orange"><Clock3 size={13} /></span>
              <span className="metric-label">Moving time</span>
              <strong>{formatDuration(route.estimatedTimeMinutes)}</strong>
            </div>
            <div className="summary-metric">
              <span className="metric-icon metric-icon-green"><ArrowUp size={13} /></span>
              <span className="metric-label">Ascent</span>
              <strong>{elevationStatus === "ready" ? `${Math.round(route.ascentMeters)} m` : "—"}</strong>
            </div>
            <div className="summary-metric">
              <span className="metric-icon metric-icon-slate"><TrendingUp size={13} /></span>
              <span className="metric-label">Steepest</span>
              <strong>{elevationStatus === "ready" ? `${Math.round(route.maxGrade * 100)}%` : "—"}</strong>
            </div>
          </div>

          {elevationStatus === "ready" ? (
            <div className="summary-section">
              <div className="summary-section-heading">
                <span>Elevation profile</span>
                <span className="summary-muted">
                  <ArrowDown size={11} /> {Math.round(route.descentMeters)} m descent
                </span>
              </div>
              <ElevationProfile
                samples={route.samples}
                hoverIndex={hoverIndex}
                onHoverIndexChange={onHoverIndexChange}
              />
            </div>
          ) : (
            <div className="summary-callout">
              <TriangleAlert size={13} />
              {elevationStatus === "loading"
                ? "Loading elevation tiles. Climb, grade, and time will update when they arrive."
                : "Elevation tiles could not be loaded, so this route assumes flat ground."}
            </div>
          )}

          <button
            className="summary-disclosure"
            type="button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((open) => !open)}
          >
            <ChevronDown size={13} className={showDetails ? "summary-disclosure-open" : ""} />
            Surface, alternatives, and notes
          </button>

          {showDetails && (
            <div className="summary-details">
              <div className="summary-section">
                <div className="summary-section-heading">
                  <span>Surface</span>
                  <span className="summary-muted">from OSM tags</span>
                </div>
                <div className="surface-bar" aria-label="Surface breakdown">
                  {route.surfaceBreakdown.map((entry) => (
                    <span
                      key={entry.surface}
                      className="surface-segment"
                      style={{
                        width: `${(entry.distanceMeters / Math.max(route.distanceMeters, 1)) * 100}%`,
                        background: SURFACE_COLORS[entry.surface],
                      }}
                    />
                  ))}
                </div>
                <div className="surface-legend">
                  {route.surfaceBreakdown.map((entry) => (
                    <span key={entry.surface}>
                      <i className="legend-dot" style={{ background: SURFACE_COLORS[entry.surface] }} />
                      {SURFACE_LABELS[entry.surface]}
                      <b>{Math.round((entry.distanceMeters / Math.max(route.distanceMeters, 1)) * 100)}%</b>
                    </span>
                  ))}
                </div>
                {route.wayNames.length > 0 && (
                  <p className="summary-ways">Follows {route.wayNames.slice(0, 4).join(", ")}
                    {route.wayNames.length > 4 ? ` and ${route.wayNames.length - 4} more` : ""}.</p>
                )}
              </div>

              {view.alternatives.length > 0 && (
                <div className="summary-section">
                  <div className="summary-section-heading"><span>Alternatives</span></div>
                  <div className="alternative-list">
                    {view.alternatives.map((alternative: OSMRoute, index) => (
                      <button
                        key={alternative.id}
                        className="alternative-row"
                        type="button"
                        onClick={() => onSelectAlternative(index)}
                      >
                        <span className="alternative-swatch" />
                        <span className="alternative-copy">
                          <strong>{alternative.objectiveLabel}</strong>
                          <small>
                            {formatDistance(alternative.distanceMeters)},{" "}
                            {formatDuration(alternative.estimatedTimeMinutes)},{" "}
                            {Math.round(alternative.ascentMeters)} m up
                          </small>
                        </span>
                        <span className="alternative-action">Use</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="summary-section summary-notes">
                <div className="summary-section-heading"><span>What this route assumes</span></div>
                {view.notes.map((note) => <p key={note}>{note}</p>)}
              </div>
            </div>
          )}

          <div className="summary-footer">
            <div className={`summary-status ${isCalculating ? "summary-status-active" : ""}`}>
              <span className={`status-dot ${isCalculating ? "status-dot-blue" : "status-dot-green"}`} />
              {isCalculating ? "Recalculating" : `${Math.round(route.confidence * 100)}% confidence`}
            </div>
            <div className="download-actions">
              <button className="download-button" type="button" onClick={() => onDownload("gpx")}>
                <Download size={12} /> GPX
              </button>
              <button className="download-button" type="button" onClick={() => onDownload("geojson")}>
                <Download size={12} /> GeoJSON
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="summary-blocked">
          <p>{view.blockedReason}</p>
          <ul>
            <li>Raise the steepest grade or the longest off-trail stretch.</li>
            <li>Allow street crossings if a road genuinely separates the two points.</li>
            <li>Move the start or target closer to a mapped path.</li>
          </ul>
        </div>
      )}
    </aside>
  );
}
