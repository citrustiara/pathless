import { Bookmark, Clock3, Trash2 } from "lucide-react";
import type { AppMode, MapPoint, ProfileId, RouteSettings } from "./pathless-types";

export type SavedRoute = {
  id: string;
  name: string;
  savedAt: number;
  mode: AppMode;
  profile: ProfileId;
  settings: RouteSettings;
  start: MapPoint;
  target: MapPoint;
  waypoints: MapPoint[];
  distanceMeters: number;
  durationMinutes: number;
};

const STORAGE_KEY = "pathless.saved-routes.v1";

export const loadSavedRoutes = (): SavedRoute[] => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SavedRoute[]) : [];
  } catch {
    return [];
  }
};

export const persistSavedRoutes = (routes: SavedRoute[]): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(routes));
  } catch {
    // A full or blocked storage quota is not worth interrupting the session for.
  }
};

const formatSavedAt = (timestamp: number): string =>
  new Date(timestamp).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

type SavedRoutesProps = {
  routes: SavedRoute[];
  onRestore: (route: SavedRoute) => void;
  onDelete: (id: string) => void;
};

export function SavedRoutes({ routes, onRestore, onDelete }: SavedRoutesProps) {
  return (
    <aside className="control-panel" aria-label="Saved routes">
      <div className="panel-section">
        <div className="section-kicker">
          <span>Saved routes</span>
          <span className="section-aside">{routes.length}</span>
        </div>
        {routes.length === 0 ? (
          <div className="saved-empty">
            <Bookmark size={18} />
            <strong>Nothing saved yet</strong>
            <small>Use Save route in the header to keep the current points and limits in this browser.</small>
          </div>
        ) : (
          <div className="saved-list">
            {routes.map((route) => (
              <div className="saved-row" key={route.id}>
                <button className="saved-restore" type="button" onClick={() => onRestore(route)}>
                  <strong>{route.name}</strong>
                  <small>
                    {(route.distanceMeters / 1_000).toFixed(2)} km
                    <span className="saved-dot-divider" />
                    {Math.round(route.durationMinutes)} min
                    <span className="saved-dot-divider" />
                    {route.mode === "nearest" ? "Nearest path" : route.mode === "design" ? "Design route" : "Destination"}
                  </small>
                  <span className="saved-time"><Clock3 size={10} />{formatSavedAt(route.savedAt)}</span>
                </button>
                <button
                  className="saved-delete"
                  type="button"
                  aria-label={`Delete ${route.name}`}
                  onClick={() => onDelete(route.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        <p className="section-note">
          Saved routes live in this browser only. Use the GPX or GeoJSON export to take one with you.
        </p>
      </div>
    </aside>
  );
}
