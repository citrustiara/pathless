import {
  Bookmark,
  ChevronsLeft,
  ChevronsRight,
  Map as MapIcon,
  Mountain,
  Save,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlsPanel } from "./components/ControlsPanel";
import { MapCanvas, type MapLayers } from "./components/MapCanvas";
import { RouteSummary } from "./components/RouteSummary";
import {
  loadSavedRoutes,
  persistSavedRoutes,
  SavedRoutes,
  type SavedRoute,
} from "./components/SavedRoutes";
import type {
  AppMode,
  ElevationStatus,
  MapPoint,
  PlacementMode,
  ProfileId,
  RouteRequest,
  RouteSettings,
  RouteView,
} from "./components/pathless-types";
import { SOPOCKA_BOUNDS, SOPOCKA_OSM_METADATA, SOPOCKA_WATERWAYS } from "./data/sopocka";
import {
  createTerrainModel,
  loadElevationGrid,
  planOSMRoute,
  type ElevationGrid,
  type OSMRoute,
  type OSMRoutingRequest,
  type TerrainModel,
} from "./engine";

const ROUTING_CELL_SIZE_METERS = 25;
const RECALCULATE_DEBOUNCE_MS = 160;
const MAX_WAYPOINTS = 8;

const INITIAL_START: MapPoint = { lat: 54.45804, lng: 18.50919 };
const INITIAL_TARGET: MapPoint = { lat: 54.46054, lng: 18.50868 };
const INITIAL_SETTINGS: RouteSettings = {
  maxGradePercent: 35,
  offTrailAversion: 2,
  maxOffTrailMeters: 300,
  allowStreetCrossing: true,
  allowStreetWalking: false,
  avoidWater: false,
  showAlternatives: true,
};
const INITIAL_LAYERS: MapLayers = { tint: true, contours: true, paths: true };

/** The routing grid never changes shape, only the elevation poured into it. */
const buildTerrain = (elevation?: ElevationGrid): TerrainModel => createTerrainModel({
  bounds: SOPOCKA_BOUNDS,
  elevation,
  cellSizeMeters: ROUTING_CELL_SIZE_METERS,
  waterways: SOPOCKA_WATERWAYS,
  id: "sopocka-25m",
  name: "Sopocka 25 m routing grid",
});

const toRoutingRequest = (request: RouteRequest): OSMRoutingRequest => ({
  mode: request.mode,
  origin: request.start,
  destination: request.mode === "nearest" ? undefined : request.target,
  waypoints: request.mode === "design" ? request.waypoints : [],
  profile: request.profile,
  maxGradePercent: request.settings.maxGradePercent,
  offTrailAversion: request.settings.offTrailAversion,
  maxOffTrailMeters: request.settings.maxOffTrailMeters,
  allowStreetCrossing: request.settings.allowStreetCrossing,
  allowStreetWalking: request.settings.allowStreetWalking,
  avoidWater: request.settings.avoidWater,
  alternatives: request.settings.showAlternatives ? 3 : 1,
});

const shareOf = (part: number, whole: number): number =>
  Math.round((part / Math.max(whole, 1)) * 100);

const buildNotes = (route: OSMRoute, request: RouteRequest, terrain: TerrainModel): string[] => {
  const mapped = shareOf(route.mappedDistanceMeters, route.distanceMeters);
  const notes = [
    mapped > 0
      ? `${mapped}% of the route follows ways that are mapped in OpenStreetMap.`
      : "No mapped way is used; the whole route crosses open ground.",
    route.offTrailDistanceMeters > 0
      ? `${Math.round(route.offTrailDistanceMeters)} m is off-trail, the longest single stretch being ${Math.round(route.longestOffTrailMeters)} m.`
      : "The route never leaves a mapped way.",
    terrain.hasElevation
      ? "Climb, grade, and time come from a public elevation model at roughly 12 m spacing."
      : "Elevation was unavailable, so climb and grade are reported as zero rather than guessed.",
    "Ground cover is not modelled: undergrowth, deadfall, and fences will not appear here.",
    request.settings.allowStreetCrossing
      ? "Street crossings are allowed anywhere, including where no crossing is mapped."
      : "Streets are only crossed where OpenStreetMap maps a crossing.",
  ];
  if (route.waterDistanceMeters > 0) {
    notes.push(`${Math.round(route.waterDistanceMeters)} m runs close to a mapped watercourse.`);
  }
  return notes;
};

const buildView = (
  request: RouteRequest,
  terrain: TerrainModel,
  preferredObjective?: string,
): RouteView => {
  const result = planOSMRoute(toRoutingRequest(request), terrain);
  if (result.routes.length === 0) {
    return {
      status: "blocked",
      title: "No feasible route",
      subtitle: request.mode === "nearest"
        ? "No mapped path can be reached from the start under these limits"
        : "The target cannot be reached under these limits",
      alternatives: [],
      notes: [],
      blockedReason: result.errors[0],
    };
  }

  const preferredIndex = preferredObjective
    ? result.routes.findIndex((route) => route.objective === preferredObjective)
    : -1;
  const chosen = preferredIndex >= 0 ? preferredIndex : 0;
  const primary = result.routes[chosen];

  return {
    status: "ready",
    title: request.mode === "nearest"
      ? "Nearest mapped path"
      : request.mode === "design"
        ? `Route through ${request.waypoints.length} waypoint${request.waypoints.length === 1 ? "" : "s"}`
        : "Route to target",
    subtitle: primary.wayNames.length > 0
      ? `Mostly ${primary.wayNames.slice(0, 2).join(" and ")}`
      : `${shareOf(primary.mappedDistanceMeters, primary.distanceMeters)}% on mapped ways`,
    route: primary,
    alternatives: result.routes.filter((_, index) => index !== chosen),
    notes: buildNotes(primary, request, terrain),
  };
};

const encodePoint = (point: MapPoint): string => `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;

const decodePoint = (value: string | null): MapPoint | undefined => {
  if (!value) return undefined;
  const [lat, lng] = value.split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
};

type PersistedState = {
  mode: AppMode;
  profile: ProfileId;
  settings: RouteSettings;
  start: MapPoint;
  target: MapPoint;
  waypoints: MapPoint[];
};

const readStateFromUrl = (): Partial<PersistedState> => {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if ([...params.keys()].length === 0) return {};
  const number = (key: string, fallback: number): number => {
    const parsed = Number(params.get(key));
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const raw = params.get(key);
    return raw === null ? fallback : raw === "1";
  };

  return {
    mode: (["nearest", "destination", "design"] as const).find((value) => value === params.get("m")),
    profile: (["hiker", "runner", "mtb"] as const).find((value) => value === params.get("p")),
    start: decodePoint(params.get("s")),
    target: decodePoint(params.get("t")),
    waypoints: (params.get("w") ?? "")
      .split(";")
      .map(decodePoint)
      .filter((point): point is MapPoint => Boolean(point)),
    settings: {
      maxGradePercent: number("g", INITIAL_SETTINGS.maxGradePercent),
      offTrailAversion: number("e", INITIAL_SETTINGS.offTrailAversion),
      maxOffTrailMeters: number("o", INITIAL_SETTINGS.maxOffTrailMeters),
      allowStreetCrossing: flag("xc", INITIAL_SETTINGS.allowStreetCrossing),
      allowStreetWalking: flag("xw", INITIAL_SETTINGS.allowStreetWalking),
      avoidWater: flag("aw", INITIAL_SETTINGS.avoidWater),
      showAlternatives: flag("alt", INITIAL_SETTINGS.showAlternatives),
    },
  };
};

const writeStateToUrl = (state: PersistedState): void => {
  const params = new URLSearchParams({
    m: state.mode,
    p: state.profile,
    s: encodePoint(state.start),
    t: encodePoint(state.target),
    g: String(state.settings.maxGradePercent),
    e: String(state.settings.offTrailAversion),
    o: String(state.settings.maxOffTrailMeters),
    xc: state.settings.allowStreetCrossing ? "1" : "0",
    xw: state.settings.allowStreetWalking ? "1" : "0",
    aw: state.settings.avoidWater ? "1" : "0",
    alt: state.settings.showAlternatives ? "1" : "0",
  });
  if (state.waypoints.length > 0) params.set("w", state.waypoints.map(encodePoint).join(";"));
  window.history.replaceState(null, "", `#${params.toString()}`);
};

const downloadRoute = (format: "gpx" | "geojson", route: OSMRoute, terrain: TerrainModel): void => {
  const points = route.coordinates.map((coordinate) => ({
    ...coordinate,
    ele: terrain.hasElevation ? terrain.elevationAt(coordinate) : undefined,
  }));
  let content: string;
  let mimeType: string;
  let extension: string;

  if (format === "gpx") {
    const body = points.map(({ lat, lng, ele }) =>
      `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">${ele === undefined ? "" : `<ele>${ele.toFixed(1)}</ele>`}</trkpt>`,
    ).join("\n");
    content = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Pathless" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Pathless route</name></metadata>
  <trk><name>Pathless route</name><trkseg>
${body}
  </trkseg></trk>
</gpx>`;
    mimeType = "application/gpx+xml";
    extension = "gpx";
  } else {
    content = JSON.stringify({
      type: "Feature",
      properties: {
        name: "Pathless route",
        distanceMeters: Math.round(route.distanceMeters),
        estimatedTimeMinutes: Math.round(route.estimatedTimeMinutes),
        ascentMeters: Math.round(route.ascentMeters),
        descentMeters: Math.round(route.descentMeters),
      },
      geometry: {
        type: "LineString",
        coordinates: points.map(({ lat, lng, ele }) =>
          ele === undefined ? [lng, lat] : [lng, lat, Number(ele.toFixed(1))]),
      },
    }, null, 2);
    mimeType = "application/geo+json";
    extension = "geojson";
  }

  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `pathless-route.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export function App() {
  const initial = useMemo(readStateFromUrl, []);
  const [mode, setMode] = useState<AppMode>(initial.mode ?? "destination");
  const [profile, setProfile] = useState<ProfileId>(initial.profile ?? "hiker");
  const [settings, setSettings] = useState<RouteSettings>(initial.settings ?? INITIAL_SETTINGS);
  const [start, setStart] = useState<MapPoint>(initial.start ?? INITIAL_START);
  const [target, setTarget] = useState<MapPoint>(initial.target ?? INITIAL_TARGET);
  const [waypoints, setWaypoints] = useState<MapPoint[]>(initial.waypoints ?? []);
  const [placementMode, setPlacementMode] = useState<PlacementMode>(null);
  const [layers, setLayers] = useState<MapLayers>(INITIAL_LAYERS);
  const [detailsHidden, setDetailsHidden] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [section, setSection] = useState<"explorer" | "saved">("explorer");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>(() => loadSavedRoutes());
  const [preferredObjective, setPreferredObjective] = useState<string | undefined>();

  const [elevation, setElevation] = useState<ElevationGrid | undefined>();
  const [elevationStatus, setElevationStatus] = useState<ElevationStatus>("loading");
  const terrain = useMemo(() => buildTerrain(elevation), [elevation]);

  const request = useMemo<RouteRequest>(
    () => ({ mode, profile, settings, start, target, waypoints }),
    [mode, profile, settings, start, target, waypoints],
  );

  const [view, setView] = useState<RouteView>(() => buildView(request, buildTerrain()));
  const [isCalculating, setIsCalculating] = useState(false);
  const latestRequest = useRef(request);
  latestRequest.current = request;

  useEffect(() => {
    let cancelled = false;
    loadElevationGrid(SOPOCKA_BOUNDS)
      .then((grid) => {
        if (cancelled) return;
        setElevation(grid);
        setElevationStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setElevationStatus("unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Routing is fast enough to run on every change, but a slider drag would
  // still fire dozens of times a second without this.
  useEffect(() => {
    setIsCalculating(true);
    const timer = window.setTimeout(() => {
      setView(buildView(request, terrain, preferredObjective));
      setIsCalculating(false);
    }, RECALCULATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [preferredObjective, request, terrain]);

  useEffect(() => {
    writeStateToUrl({ mode, profile, settings, start, target, waypoints });
  }, [mode, profile, settings, start, target, waypoints]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "escape") setPlacementMode(null);
      if (key === "s") setPlacementMode((current) => (current === "start" ? null : "start"));
      if (key === "t" && mode !== "nearest") {
        setPlacementMode((current) => (current === "target" ? null : "target"));
      }
      if (key === "w" && mode === "design") {
        setPlacementMode((current) => (current === "waypoint" ? null : "waypoint"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

  const handleMapClick = useCallback((point: MapPoint) => {
    if (placementMode === "start") setStart(point);
    if (placementMode === "target") setTarget(point);
    if (placementMode === "waypoint") {
      setWaypoints((current) => (current.length < MAX_WAYPOINTS ? [...current, point] : current));
    }
    // The placement mode deliberately stays active so several points can be
    // dropped in a row; Esc or the Done button ends it.
  }, [placementMode]);

  const handleMovePoint = useCallback(
    (kind: "start" | "target" | "waypoint", index: number, point: MapPoint) => {
      if (kind === "start") setStart(point);
      if (kind === "target") setTarget(point);
      if (kind === "waypoint") {
        setWaypoints((current) => current.map((existing, position) => (position === index ? point : existing)));
      }
    },
    [],
  );

  const handleReset = useCallback(() => {
    setMode("destination");
    setProfile("hiker");
    setSettings(INITIAL_SETTINGS);
    setStart(INITIAL_START);
    setTarget(INITIAL_TARGET);
    setWaypoints([]);
    setPlacementMode(null);
    setPreferredObjective(undefined);
  }, []);

  const handleSelectAlternative = useCallback((index: number) => {
    const alternative = view.alternatives[index];
    if (alternative) setPreferredObjective(alternative.objective);
  }, [view.alternatives]);

  const handleSaveRoute = useCallback(() => {
    if (!view.route) return;
    const entry: SavedRoute = {
      id: `${Date.now()}`,
      name: view.title,
      savedAt: Date.now(),
      mode,
      profile,
      settings,
      start,
      target,
      waypoints,
      distanceMeters: view.route.distanceMeters,
      durationMinutes: view.route.estimatedTimeMinutes,
    };
    const next = [entry, ...savedRoutes].slice(0, 30);
    setSavedRoutes(next);
    persistSavedRoutes(next);
    setSection("saved");
  }, [mode, profile, savedRoutes, settings, start, target, view.route, view.title, waypoints]);

  const handleRestoreRoute = useCallback((saved: SavedRoute) => {
    setMode(saved.mode);
    setProfile(saved.profile);
    setSettings(saved.settings);
    setStart(saved.start);
    setTarget(saved.target);
    setWaypoints(saved.waypoints);
    setSection("explorer");
  }, []);

  const handleDeleteRoute = useCallback((id: string) => {
    setSavedRoutes((current) => {
      const next = current.filter((route) => route.id !== id);
      persistSavedRoutes(next);
      return next;
    });
  }, []);

  const hoverPoint = hoverIndex !== null && view.route?.coordinates[hoverIndex]
    ? view.route.coordinates[hoverIndex]
    : null;

  return (
    <div className={`app-shell ${railCollapsed ? "app-shell-rail-collapsed" : ""}`}>
      <aside className="left-rail">
        <div className="brand-mark">
          <span className="brand-glyph"><span /><span /><span /></span>
          <span className="brand-name">PATHLESS</span>
        </div>
        <nav className="rail-nav" aria-label="Primary navigation">
          <button
            className={`rail-link ${section === "explorer" ? "rail-link-active" : ""}`}
            type="button"
            onClick={() => setSection("explorer")}
          >
            <MapIcon size={16} /><span>Route explorer</span>
          </button>
          <button
            className={`rail-link ${section === "saved" ? "rail-link-active" : ""}`}
            type="button"
            onClick={() => setSection("saved")}
          >
            <Bookmark size={16} /><span>Saved routes</span>
            {savedRoutes.length > 0 && <span className="rail-link-count">{savedRoutes.length}</span>}
          </button>
        </nav>
        <div className="rail-footer">
          <div className="rail-status">
            <span className={`status-dot ${elevationStatus === "ready" ? "status-dot-green" : elevationStatus === "loading" ? "status-dot-blue" : "status-dot-orange"}`} />
            <span>
              <strong>
                {elevationStatus === "ready" ? "Elevation loaded" : elevationStatus === "loading" ? "Loading elevation" : "Elevation offline"}
              </strong>
              <small>{SOPOCKA_OSM_METADATA.featureCount.toLocaleString()} OSM ways imported</small>
            </span>
          </div>
          <button
            className="rail-collapse"
            type="button"
            onClick={() => setRailCollapsed((collapsed) => !collapsed)}
            aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"}
          >
            {railCollapsed ? <ChevronsRight size={14} /> : <ChevronsLeft size={14} />}
            <span>Collapse</span>
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <div className="breadcrumbs">
              <Mountain size={14} />
              <strong>Sopocka, Gdynia</strong>
              <span className="breadcrumb-tag">
                {section === "saved" ? "Saved routes" : "Route explorer"}
              </span>
            </div>
          </div>
          <div className="topbar-right">
            <span className="topbar-hint">
              <kbd>S</kbd><kbd>T</kbd><kbd>W</kbd> place points, <kbd>Esc</kbd> to stop
            </span>
            <button
              className="button button-primary button-compact"
              type="button"
              onClick={handleSaveRoute}
              disabled={!view.route}
            >
              <Save size={13} /> Save route
            </button>
          </div>
        </header>

        <div className="workspace-layout">
          {section === "saved" ? (
            <SavedRoutes
              routes={savedRoutes}
              onRestore={handleRestoreRoute}
              onDelete={handleDeleteRoute}
            />
          ) : (
            <ControlsPanel
              mode={mode}
              profile={profile}
              settings={settings}
              start={start}
              target={target}
              waypoints={waypoints}
              placementMode={placementMode}
              isCalculating={isCalculating}
              onModeChange={setMode}
              onProfileChange={setProfile}
              onSettingsChange={setSettings}
              onPlacementModeChange={setPlacementMode}
              onClearWaypoint={(index) =>
                setWaypoints((current) => current.filter((_, position) => position !== index))}
              onReset={handleReset}
            />
          )}

          <main className="map-column">
            <MapCanvas
              view={view}
              mode={mode}
              start={start}
              target={target}
              waypoints={waypoints}
              placementMode={placementMode}
              isCalculating={isCalculating}
              elevationStatus={elevationStatus}
              elevationGrid={elevation}
              terrain={terrain}
              layers={layers}
              detailsHidden={detailsHidden}
              hoverPoint={hoverPoint}
              onLayersChange={setLayers}
              onMapClick={handleMapClick}
              onPlacementModeChange={setPlacementMode}
              onMovePoint={handleMovePoint}
              onSelectAlternative={handleSelectAlternative}
            >
              <RouteSummary
                view={view}
                isCalculating={isCalculating}
                isHidden={detailsHidden}
                elevationStatus={elevationStatus}
                hoverIndex={hoverIndex}
                onHoverIndexChange={setHoverIndex}
                onHiddenChange={setDetailsHidden}
                onSelectAlternative={handleSelectAlternative}
                onDownload={(format) => view.route && downloadRoute(format, view.route, terrain)}
              />
            </MapCanvas>
          </main>
        </div>
      </div>
    </div>
  );
}
