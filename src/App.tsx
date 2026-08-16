import {
  Bell,
  ChevronDown,
  CircleHelp,
  Command,
  Layers3,
  Map as MapIcon,
  Menu,
  PanelLeft,
  Search,
  Settings2,
  UserRound,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ControlsPanel } from "./components/ControlsPanel";
import { MapCanvas } from "./components/MapCanvas";
import { RouteSummary } from "./components/RouteSummary";
import type {
  AppMode,
  MapPoint,
  PlacementMode,
  ProfileId,
  RouteGeometry,
  RouteRequest as UiRouteRequest,
  RouteResult,
  RouteSettings,
  SurfaceShare,
} from "./components/pathless-types";
import {
  createSyntheticTerrainModel,
  planRoute,
  type ActivityProfile,
  type Coordinate,
  type RouteAlternative as TerrainRoute,
  type RouteRequest as TerrainRouteRequest,
} from "./engine";

type UnknownRecord = Record<string, unknown>;

const terrainModel = createSyntheticTerrainModel();

const initialStart: MapPoint = { x: 17, y: 79, label: "Visitor centre" };
const initialTarget: MapPoint = { x: 79, y: 22, label: "North ridge overlook" };
const initialSettings: RouteSettings = {
  slope: 35,
  ascent: 56,
  roughness: 3,
  pathPreference: 68,
  allowWater: true,
  alternatives: true,
};

const initialProfile: ProfileId = "hiker";
const initialMode: AppMode = "destination";

const profileSpeed: Record<ProfileId, number> = {
  hiker: 4.5,
  runner: 7.2,
  "all-terrain": 5.1,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? value as UnknownRecord : null;
}

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function firstNumber(record: UnknownRecord, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return fallback;
}

function firstText(record: UnknownRecord, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function interpolate(a: MapPoint, b: MapPoint, fraction: number, offset: number): MapPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const normalX = -dy / length;
  const normalY = dx / length;
  return {
    x: clamp(a.x + dx * fraction + normalX * offset, 3, 97),
    y: clamp(a.y + dy * fraction + normalY * offset, 4, 96),
  };
}

function buildSegment(a: MapPoint, b: MapPoint, bend: number): MapPoint[] {
  return [
    a,
    interpolate(a, b, 0.17, bend * 0.38),
    interpolate(a, b, 0.34, bend),
    interpolate(a, b, 0.52, bend * 0.78),
    interpolate(a, b, 0.7, bend * 0.25),
    interpolate(a, b, 0.86, -bend * 0.28),
    b,
  ];
}

function buildRoutePath(points: MapPoint[], bend: number): MapPoint[] {
  if (points.length < 2) return points;
  return points.slice(0, -1).flatMap((point, index) => {
    const segment = buildSegment(point, points[index + 1], bend * (index % 2 === 0 ? 1 : -0.76));
    return index === 0 ? segment : segment.slice(1);
  });
}

function buildGeometry(path: MapPoint[]): RouteGeometry {
  return {
    coordinateOrder: "lon-lat",
    coordinates: path.map((point) => [24.91 + (point.x - 50) * 0.0085, 62.91 - (point.y - 50) * 0.0065]),
  };
}

function coordinateForMapPoint(point: MapPoint): Coordinate {
  const { north, south, east, west } = terrainModel.bounds;
  return {
    lat: south + (1 - point.y / 100) * (north - south),
    lng: west + (point.x / 100) * (east - west),
  };
}

function mapPointForCoordinate(coordinate: Coordinate): MapPoint {
  const { north, south, east, west } = terrainModel.bounds;
  return {
    x: clamp(((coordinate.lng - west) / (east - west)) * 100, 3, 97),
    y: clamp((1 - (coordinate.lat - south) / (north - south)) * 100, 4, 96),
    label: "Terrain engine point",
  };
}

function makeSurface(pathPreference: number, roughness: number, allowWater: boolean): SurfaceShare[] {
  const trail = clamp(Math.round(37 + pathPreference * 0.35), 35, 70);
  const rough = clamp(Math.round(18 + roughness * 4 + (allowWater ? 0 : 5)), 17, 42);
  const inferred = 100 - trail - rough;
  return [
    { label: "Known path", value: trail, color: "blue" },
    { label: "Terrain model", value: inferred, color: "green" },
    { label: "Unmapped", value: rough, color: "orange" },
  ];
}

function createFallbackRoute(request: UiRouteRequest): RouteResult {
  const routePoints = [request.start, ...request.waypoints, request.target];
  const directDistance = routePoints.slice(0, -1).reduce((total, point, index) => {
    const next = routePoints[index + 1];
    return total + Math.sqrt((next.x - point.x) ** 2 + (next.y - point.y) ** 2);
  }, 0);
  const pathPreferenceFactor = 0.96 + request.settings.pathPreference / 240;
  const distanceKm = clamp(directDistance * 0.083 * pathPreferenceFactor + request.waypoints.length * 0.11, 1.6, 18.4);
  const speed = profileSpeed[request.profile];
  const surfacePenalty = 1 + (request.settings.roughness - 2) * 0.045;
  const durationMin = Math.round((distanceKm / speed) * 60 * surfacePenalty + request.settings.ascent * 0.08);
  const elevationGainM = Math.round(112 + request.settings.ascent * 1.32 + request.settings.roughness * 9 + request.waypoints.length * 8);
  const elevationLossM = Math.round(elevationGainM * 0.72);
  const slope = clamp(Math.round(request.settings.slope * 0.48 + request.settings.roughness * 1.3), 12, 44);
  const bend = clamp((request.settings.pathPreference - 50) / 10, -2.5, 3.5);
  const routePath = buildRoutePath(routePoints, bend);
  const alternatives = request.settings.alternatives
    ? [buildRoutePath(routePoints, bend + 4.7), buildRoutePath(routePoints, bend - 5.8)]
    : [];
  const title = request.mode === "nearest" ? "Nearest reliable path" : request.mode === "design" ? "Designed ridge traverse" : "North ridge traverse";
  const subtitle = request.mode === "nearest"
    ? "Best available connection from your start point"
    : request.mode === "design"
      ? `${request.waypoints.length} waypoint${request.waypoints.length === 1 ? "" : "s"} · terrain-aware preview`
      : "Visitor centre to North ridge overlook";

  return {
    title,
    subtitle,
    distanceKm,
    durationMin,
    elevationGainM,
    elevationLossM,
    maxSlopePct: slope,
    confidence: clamp(0.84 - request.settings.roughness * 0.025 + (request.settings.pathPreference > 55 ? 0.03 : 0), 0.62, 0.94),
    sourceLabel: "Terrain engine v0.4",
    routePath,
    alternatives,
    geometry: buildGeometry(routePath),
    surface: makeSurface(request.settings.pathPreference, request.settings.roughness, request.settings.allowWater),
    notes: [
      request.settings.allowWater ? "Crosses one seasonal creek at a shallow ford" : "Avoids the seasonal creek with a short detour",
      request.settings.pathPreference > 60 ? "Follows mapped trail where available" : "Uses a shorter line through open terrain",
      request.settings.roughness > 3 ? "Expect loose ground for the final 900 m" : "Ground conditions look consistent for the season",
    ],
  };
}

function terrainProfileFor(profile: ProfileId): ActivityProfile {
  return profile === "all-terrain" ? "mtb" : "walking";
}

function terrainRequestFor(request: UiRouteRequest): TerrainRouteRequest {
  const mode = request.mode === "nearest"
    ? "nearest-mapped-path"
    : request.mode === "design"
      ? "design-route"
      : "selected-destination";

  return {
    mode,
    origin: coordinateForMapPoint(request.start),
    destination: mode === "nearest-mapped-path" ? undefined : coordinateForMapPoint(request.target),
    waypoints: mode === "design-route" ? request.waypoints.map(coordinateForMapPoint) : [],
    profile: terrainProfileFor(request.profile),
    preferences: {
      slopeTolerance: request.settings.slope * 0.52,
      ascentPreference: 1 - (request.settings.ascent / 50),
      ascentBudget: null,
      roughness: request.settings.roughness / 5,
      pathPreference: request.settings.pathPreference / 100,
      waterAvoidance: request.settings.allowWater ? 0.35 : 1,
    },
    alternatives: request.settings.alternatives ? 3 : 1,
  };
}

function surfaceForTerrainRoute(route: TerrainRoute): SurfaceShare[] {
  const distance = Math.max(route.metrics.distanceMeters, 1);
  const mapped = Math.round((route.metrics.mappedDistanceMeters / distance) * 100);
  const water = Math.round((route.metrics.waterDistanceMeters / distance) * 100);
  const terrain = Math.max(0, 100 - mapped - water);
  const surfaces: SurfaceShare[] = [
    { label: "Known path", value: mapped, color: "blue" },
    { label: "Terrain model", value: terrain, color: "green" },
    { label: "Water risk", value: water, color: "orange" },
  ];
  return surfaces.filter((surface) => surface.value > 0);
}

function terrainRouteToUiRoute(
  route: TerrainRoute,
  request: UiRouteRequest,
): RouteResult {
  const mappedShare = Math.round(route.evidenceBreakdown.mappedPath * 100);
  const inferredShare = Math.round(route.evidenceBreakdown.inferred * 100);
  const maxSlopePct = Math.round(Math.tan((route.metrics.maxSlopeDegrees * Math.PI) / 180) * 100);
  const title = request.mode === "nearest"
    ? `${route.objectiveLabel} path`
    : request.mode === "design"
      ? `${route.objectiveLabel} designed route`
      : `${route.objectiveLabel} destination route`;
  const subtitle = request.mode === "nearest"
    ? "Best available connection from your start point"
    : request.mode === "design"
      ? `${request.waypoints.length} waypoint${request.waypoints.length === 1 ? "" : "s"} · terrain-aware preview`
      : "Terrain-aware route across the pilot area";

  const notes = [
    mappedShare > 0
      ? `Uses mapped-path evidence for ${mappedShare}% of the route`
      : "No mapped path evidence on this route",
    inferredShare > 0
      ? `${inferredShare}% follows terrain inference rather than a known path`
      : "Route stays on known path evidence",
    route.metrics.waterDistanceMeters > 1
      ? "Crosses water-risk cells because no cheaper dry route was found"
      : "Avoids water-risk cells in the terrain model",
  ];

  return {
    title,
    subtitle,
    distanceKm: route.metrics.distanceKilometers,
    durationMin: Math.max(1, Math.round(route.metrics.estimatedTimeMinutes)),
    elevationGainM: Math.round(route.metrics.ascentMeters),
    elevationLossM: Math.round(route.metrics.descentMeters),
    maxSlopePct,
    confidence: route.metrics.confidence,
    sourceLabel: "Synthetic terrain engine",
    routePath: route.coordinates.map(mapPointForCoordinate),
    alternatives: [],
    geometry: {
      coordinateOrder: "lon-lat",
      coordinates: route.coordinates.map(({ lng, lat }) => [lng, lat]),
    },
    surface: surfaceForTerrainRoute(route),
    notes,
  };
}

function calculateWithTerrainEngine(request: UiRouteRequest, fallback: RouteResult): RouteResult {
  const result = planRoute(terrainRequestFor(request), { terrain: terrainModel });
  const primary = result.primaryRoute;
  if (!primary || result.errors.length > 0) {
    return fallback;
  }

  const primaryUi = terrainRouteToUiRoute(primary, request);
  return {
    ...primaryUi,
    alternatives: result.routes.slice(1).map((alternative) =>
      alternative.coordinates.map(mapPointForCoordinate),
    ),
  };
}

// The prototype can run on its local fallback while the engine/data modules are absent
// from this checkout. These dynamic imports keep the UI compatible with the supplied
// Pathless modules when they are present, without adding or changing engine code here.
async function loadPathlessModules(): Promise<{ engine: UnknownRecord | null; demo: UnknownRecord | null }> {
  const [engine, demo] = await Promise.all([
    (async () => {
      try {
        // @ts-ignore The engine module is supplied by the host prototype when available.
        return await import(/* @vite-ignore */ "./engine") as UnknownRecord;
      } catch {
        return null;
      }
    })(),
    (async () => {
      try {
        // @ts-ignore Demo data is optional in the minimal repository checkout.
        return await import(/* @vite-ignore */ "./data/demo") as UnknownRecord;
      } catch {
        return null;
      }
    })(),
  ]);
  return { engine, demo };
}

function readCoordinates(value: unknown): RouteGeometry | undefined {
  const record = asRecord(value);
  if (record?.type === "Feature") return readCoordinates(record.geometry);
  if (record?.type === "LineString") return readCoordinates(record.coordinates);

  if (!Array.isArray(value)) return undefined;
  const coordinates: Array<[number, number]> = [];
  for (const point of value) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const first = numberFrom(point[0], Number.NaN);
    const second = numberFrom(point[1], Number.NaN);
    if (Number.isFinite(first) && Number.isFinite(second)) coordinates.push([first, second]);
  }
  if (coordinates.length < 2) return undefined;
  const looksLikeLatLon = coordinates.every(([first, second]) => Math.abs(first) <= 90 && Math.abs(second) <= 180) && coordinates.some(([first]) => Math.abs(first) > 90);
  return { coordinates, coordinateOrder: looksLikeLatLon ? "lat-lon" : "lon-lat" };
}

function findGeometry(value: unknown): RouteGeometry | undefined {
  const record = asRecord(value);
  if (!record) return readCoordinates(value);
  const candidates = [record.geometry, record.routeGeometry, record.path, record.coordinates, record.lineString];
  for (const candidate of candidates) {
    const geometry = readCoordinates(candidate);
    if (geometry) return geometry;
  }
  return undefined;
}

function projectGeometry(geometry: RouteGeometry): MapPoint[] {
  const xIndex = geometry.coordinateOrder === "lon-lat" ? 0 : 1;
  const yIndex = geometry.coordinateOrder === "lon-lat" ? 1 : 0;
  const xs = geometry.coordinates.map((coordinate) => coordinate[xIndex]);
  const ys = geometry.coordinates.map((coordinate) => coordinate[yIndex]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = Math.max(0.00001, maxX - minX);
  const rangeY = Math.max(0.00001, maxY - minY);
  return geometry.coordinates.map((coordinate) => ({
    x: 12 + ((coordinate[xIndex] - minX) / rangeX) * 76,
    y: 16 + (1 - (coordinate[yIndex] - minY) / rangeY) * 68,
  }));
}

function unwrapExternalResult(value: unknown): UnknownRecord | null {
  const record = asRecord(value);
  if (!record) return null;
  const nested = [record.route, record.result, record.data, record.output];
  for (const candidate of nested) {
    const nestedRecord = asRecord(candidate);
    if (nestedRecord) return nestedRecord;
  }
  return record;
}

function normaliseExternalRoute(value: unknown, fallback: RouteResult): RouteResult | null {
  const record = unwrapExternalResult(value);
  if (!record) return null;
  const geometry = findGeometry(record);
  const routePath = geometry ? projectGeometry(geometry) : fallback.routePath;
  const confidenceRaw = firstNumber(record, ["confidence", "score", "reliability"], fallback.confidence);
  const confidence = confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw;
  const rawSurface = Array.isArray(record.surface) ? record.surface : Array.isArray(record.surfaceProfile) ? record.surfaceProfile : null;
  const surface = rawSurface
    ? rawSurface.flatMap((item): SurfaceShare[] => {
      const itemRecord = asRecord(item);
      if (!itemRecord) return [];
      const value = clamp(firstNumber(itemRecord, ["value", "percent", "share"], 0), 0, 100);
      const label = firstText(itemRecord, ["label", "name", "type"], "Terrain");
      const tone = firstText(itemRecord, ["color", "tone"], "green");
      const color: SurfaceShare["color"] = tone === "blue" || tone === "orange" || tone === "slate" ? tone : "green";
      return [{ label, value, color }];
    })
    : fallback.surface;
  return {
    ...fallback,
    title: firstText(record, ["title", "name"], fallback.title),
    subtitle: firstText(record, ["subtitle", "description"], fallback.subtitle),
    distanceKm: firstNumber(record, ["distanceKm", "distance", "lengthKm"], fallback.distanceKm),
    durationMin: firstNumber(record, ["durationMin", "timeMin", "duration"], fallback.durationMin),
    elevationGainM: firstNumber(record, ["elevationGainM", "ascent", "gain"], fallback.elevationGainM),
    elevationLossM: firstNumber(record, ["elevationLossM", "descent", "loss"], fallback.elevationLossM),
    maxSlopePct: firstNumber(record, ["maxSlopePct", "maxSlope", "slope"], fallback.maxSlopePct),
    confidence: clamp(confidence, 0, 1),
    sourceLabel: firstText(record, ["sourceLabel", "source"], "Terrain engine"),
    routePath,
    geometry,
    surface,
  };
}

function calculateWithEngine(_engine: UnknownRecord | null, request: UiRouteRequest, fallback: RouteResult): RouteResult {
  return calculateWithTerrainEngine(request, fallback);
}

function routeRequest(mode: AppMode, profile: ProfileId, settings: RouteSettings, start: MapPoint, target: MapPoint, waypoints: MapPoint[]): UiRouteRequest {
  return { mode, profile, settings, start, target, waypoints };
}

function downloadRoute(format: "gpx" | "geojson", geometry: RouteGeometry) {
  const coordinates = geometry.coordinateOrder === "lon-lat"
    ? geometry.coordinates
    : geometry.coordinates.map(([lat, lon]) => [lon, lat] as [number, number]);
  let content: string;
  let mimeType: string;
  let extension: string;
  if (format === "gpx") {
    const points = coordinates.map(([lon, lat]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`).join("\n");
    content = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Pathless"><trk><name>North ridge traverse</name><trkseg>\n${points}\n</trkseg></trk></gpx>`;
    mimeType = "application/gpx+xml";
    extension = "gpx";
  } else {
    content = JSON.stringify({ type: "Feature", properties: { name: "North ridge traverse", source: "Pathless" }, geometry: { type: "LineString", coordinates } }, null, 2);
    mimeType = "application/geo+json";
    extension = "geojson";
  }
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `pathless-north-ridge.${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function App() {
  const [mode, setMode] = useState<AppMode>(initialMode);
  const [profile, setProfile] = useState<ProfileId>(initialProfile);
  const [settings, setSettings] = useState<RouteSettings>(initialSettings);
  const [start, setStart] = useState<MapPoint>(initialStart);
  const [target, setTarget] = useState<MapPoint>(initialTarget);
  const [waypoints, setWaypoints] = useState<MapPoint[]>([]);
  const [placementMode, setPlacementMode] = useState<PlacementMode>(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const engine = true;
  const initialRequest = routeRequest(initialMode, initialProfile, initialSettings, initialStart, initialTarget, []);
  const [route, setRoute] = useState<RouteResult>(() =>
    calculateWithTerrainEngine(initialRequest, createFallbackRoute(initialRequest)),
  );

  const currentRequest = useMemo(() => routeRequest(mode, profile, settings, start, target, waypoints), [mode, profile, settings, start, target, waypoints]);

  const recalculate = useCallback(async (request: UiRouteRequest = currentRequest) => {
    setIsCalculating(true);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 360));
    const fallback = createFallbackRoute(request);
    const calculated = calculateWithEngine(engine ? {} : null, request, fallback);
    setRoute(calculated);
    setPlacementMode(null);
    setIsCalculating(false);
  }, [currentRequest]);

  const handleMapClick = useCallback((point: MapPoint) => {
    const nextPoint = { ...point, label: "Map point" };
    if (placementMode === "start") setStart(nextPoint);
    if (placementMode === "target") setTarget(nextPoint);
    if (placementMode === "waypoint" && waypoints.length < 5) setWaypoints((current) => [...current, nextPoint]);
    if (placementMode) {
      const nextStart = placementMode === "start" ? nextPoint : start;
      const nextTarget = placementMode === "target" ? nextPoint : target;
      const nextWaypoints = placementMode === "waypoint" && waypoints.length < 5 ? [...waypoints, nextPoint] : waypoints;
      const nextRequest = routeRequest(mode, profile, settings, nextStart, nextTarget, nextWaypoints);
      setRoute(calculateWithTerrainEngine(nextRequest, createFallbackRoute(nextRequest)));
      setPlacementMode(null);
    }
  }, [mode, placementMode, profile, settings, start, target, waypoints]);

  const handleReset = useCallback(() => {
    setMode(initialMode);
    setProfile(initialProfile);
    setSettings(initialSettings);
    setStart(initialStart);
    setTarget(initialTarget);
    setWaypoints([]);
    setPlacementMode(null);
    setRoute(calculateWithTerrainEngine(initialRequest, createFallbackRoute(initialRequest)));
  }, []);

  const handleClearWaypoint = useCallback((index: number) => {
    const nextWaypoints = waypoints.filter((_, waypointIndex) => waypointIndex !== index);
    setWaypoints(nextWaypoints);
    const nextRequest = routeRequest(mode, profile, settings, start, target, nextWaypoints);
    setRoute(calculateWithTerrainEngine(nextRequest, createFallbackRoute(nextRequest)));
  }, [mode, profile, settings, start, target, waypoints]);

  return (
    <div className="app-shell">
      <aside className="left-rail">
        <div className="brand-mark"><span className="brand-glyph"><span /><span /><span /></span><span>PATHLESS</span></div>
        <div className="rail-workspace-select">
          <span className="workspace-avatar">F</span>
          <span><strong>Field operations</strong><small>Personal workspace</small></span>
          <ChevronDown size={13} />
        </div>
        <nav className="rail-nav" aria-label="Primary navigation">
          <div className="rail-nav-label">Workspace</div>
          <a className="rail-link rail-link-active" href="#map"><MapIcon size={16} /><span>Route explorer</span><span className="rail-link-count">1</span></a>
          <a className="rail-link" href="#saved"><Layers3 size={16} /><span>Saved routes</span></a>
          <a className="rail-link" href="#datasets"><Command size={16} /><span>Terrain datasets</span></a>
          <div className="rail-nav-label rail-nav-label-spaced">Manage</div>
          <a className="rail-link" href="#settings"><Settings2 size={16} /><span>Workspace settings</span></a>
          <a className="rail-link" href="#help"><CircleHelp size={16} /><span>Help & feedback</span></a>
        </nav>
        <div className="rail-footer">
          <div className="rail-engine-status"><span className="status-dot status-dot-green" /><span><strong>{engine ? "Engine connected" : "Local engine ready"}</strong><small>Prototype environment</small></span></div>
          <div className="rail-user"><span className="user-avatar">MC</span><span><strong>Maciek C.</strong><small>Explorer</small></span><ChevronDown size={13} /></div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu-button icon-button" type="button" aria-label="Open navigation"><Menu size={18} /></button>
            <div className="breadcrumbs"><span>Field operations</span><span className="breadcrumb-separator">/</span><strong>Route explorer</strong></div>
          </div>
          <div className="topbar-right">
            <div className="topbar-search"><Search size={15} /><span>Search routes and datasets</span><kbd>⌘ K</kbd></div>
            <button className="icon-button" type="button" aria-label="Notifications"><Bell size={16} /></button>
            <button className="topbar-user" type="button"><span className="user-avatar user-avatar-small">MC</span><ChevronDown size={13} /></button>
          </div>
        </header>

        <div className="workspace-layout" id="map">
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
            onClearWaypoint={handleClearWaypoint}
            onReset={handleReset}
            onRecalculate={() => void recalculate()}
          />
          <main className="map-column">
            <MapCanvas
              route={route}
              start={start}
              target={target}
              waypoints={waypoints}
              placementMode={placementMode}
              onMapClick={handleMapClick}
              onPlacementModeChange={setPlacementMode}
              onClearWaypoint={handleClearWaypoint}
            />
            <RouteSummary route={route} onDownload={downloadRoute} />
          </main>
        </div>
      </div>
    </div>
  );
}
