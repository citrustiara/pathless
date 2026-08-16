import { ArrowDown, ArrowUp, Clock3, Download, Gauge, Route as RouteIcon, ShieldCheck } from "lucide-react";
import type { RouteGeometry, RouteResult } from "./pathless-types";

type RouteSummaryProps = {
  route: RouteResult;
  onDownload: (format: "gpx" | "geojson", geometry: RouteGeometry) => void;
};

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0 ? `${hours}h ${remaining}m` : `${remaining} min`;
}

export function RouteSummary({ route, onDownload }: RouteSummaryProps) {
  const geometryAvailable = Boolean(route.geometry);

  return (
    <aside className="route-summary" aria-label="Route details">
      <div className="summary-header">
        <div>
          <div className="eyebrow">Recommended route</div>
          <h2>{route.title}</h2>
          <p>{route.subtitle}</p>
        </div>
        <div className="confidence-badge">
          <ShieldCheck size={14} />
          {Math.round(route.confidence * 100)}%
        </div>
      </div>

      <div className="summary-metrics">
        <div className="summary-metric">
          <span className="metric-icon metric-icon-blue"><RouteIcon size={14} /></span>
          <span className="metric-label">Distance</span>
          <strong>{route.distanceKm.toFixed(1)} km</strong>
        </div>
        <div className="summary-metric">
          <span className="metric-icon metric-icon-orange"><Clock3 size={14} /></span>
          <span className="metric-label">Moving time</span>
          <strong>{formatDuration(route.durationMin)}</strong>
        </div>
        <div className="summary-metric">
          <span className="metric-icon metric-icon-green"><ArrowUp size={14} /></span>
          <span className="metric-label">Ascent</span>
          <strong>{route.elevationGainM} m</strong>
        </div>
        <div className="summary-metric">
          <span className="metric-icon metric-icon-slate"><Gauge size={14} /></span>
          <span className="metric-label">Max slope</span>
          <strong>{route.maxSlopePct}%</strong>
        </div>
      </div>

      <div className="summary-section">
        <div className="summary-section-heading">
          <span>Surface profile</span>
          <span className="summary-muted">{route.sourceLabel}</span>
        </div>
        <div className="surface-bar" aria-label="Surface profile distribution">
          {route.surface.map((surface) => (
            <span className={`surface-segment surface-segment-${surface.color}`} style={{ width: `${surface.value}%` }} key={surface.label} />
          ))}
        </div>
        <div className="surface-legend">
          {route.surface.map((surface) => (
            <span key={surface.label}><i className={`legend-dot legend-dot-${surface.color}`} />{surface.label} {surface.value}%</span>
          ))}
        </div>
      </div>

      <div className="summary-section summary-notes">
        <div className="summary-section-heading">
          <span>Route notes</span>
          <span className="data-quality"><span className="status-dot status-dot-green" />Data quality: good</span>
        </div>
        {route.notes.map((note) => <p key={note}><span className="note-check">✓</span>{note}</p>)}
      </div>

      <div className="summary-footer">
        <div className="summary-footer-meta"><ArrowDown size={13} />{route.elevationLossM} m descent</div>
        <div className="download-actions">
          {geometryAvailable ? (
            <>
              <button className="download-button" type="button" onClick={() => onDownload("gpx", route.geometry!)}>
                <Download size={13} /> GPX
              </button>
              <button className="download-button" type="button" onClick={() => onDownload("geojson", route.geometry!)}>
                <Download size={13} /> GeoJSON
              </button>
            </>
          ) : (
            <span className="summary-muted">Geometry export unavailable</span>
          )}
        </div>
      </div>
    </aside>
  );
}

