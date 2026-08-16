/**
 * Deterministic fixtures for the Pathless pilot UI and routing engine.
 *
 * Coordinates in this module are WGS84 objects with `lat` and `lng` fields.
 * They carry the same latitude/longitude order used by Leaflet and the
 * engine, and are intentionally not GeoJSON coordinates (`[longitude,
 * latitude]`). Every geometry and terrain label below is synthetic: it keeps
 * the prototype runnable without shipping a large external dataset and does
 * not make claims about real-world access, elevation, or track conditions.
 */

import {
  SYNTHETIC_TERRAIN_CENTER,
  type Coordinate as EngineCoordinate,
  type GeoBounds as EngineGeoBounds,
  type MappedPathKind as EngineMappedPathKind,
} from "../engine/types";

export type Coordinate = EngineCoordinate;
export type LatLng = Coordinate;
export type Bounds = EngineGeoBounds;

export type DataSourceId = "synthetic" | "osm" | "geoportal" | "lidar";

export type TerrainLayerId =
  | "elevation"
  | "slope"
  | "land-cover"
  | "wetness";

export type MappedPathKind = Exclude<EngineMappedPathKind, "none">;

export interface PilotArea {
  id: string;
  name: string;
  region: string;
  description: string;
  center: Coordinate;
  bounds: Bounds;
  boundary: Coordinate[];
  coordinateOrder: "lat,lng";
  sourceId: DataSourceId;
  isSynthetic: boolean;
}

export interface DemoPoint {
  id: string;
  label: string;
  role: "start" | "end";
  coordinate: Coordinate;
  description: string;
  sourceId: DataSourceId;
  isSynthetic: boolean;
}

export interface MappedPath {
  id: string;
  name: string;
  kind: MappedPathKind;
  coordinates: Coordinate[];
  surface: string;
  description: string;
  sourceId: DataSourceId;
  isSynthetic: boolean;
}

export interface TerrainLayer {
  id: TerrainLayerId;
  label: string;
  description: string;
  unit: string;
  sourceId: DataSourceId;
  intendedAdapter: "geoportal" | "lidar";
  status: "synthetic" | "planned";
  visibleByDefault: boolean;
}

export interface DataSourceAttribution {
  id: DataSourceId;
  label: string;
  attribution: string;
  url?: string;
  license: string;
  status: "included" | "planned";
  notes: string;
}

/** The deliberately small synthetic extent used by the demo. */
export const DEMO_BOUNDS: Bounds = {
  north: 54.4746,
  south: 54.4422,
  east: 18.5371,
  west: 18.4813,
};

/** A closed polygon for a Leaflet `Polygon`; the last point repeats the first. */
export const DEMO_BOUNDARY: Coordinate[] = [
  { lat: 54.4746, lng: 18.4813 },
  { lat: 54.4746, lng: 18.5371 },
  { lat: 54.4422, lng: 18.5371 },
  { lat: 54.4422, lng: 18.4813 },
  { lat: 54.4746, lng: 18.4813 },
];

export const PILOT_AREA: PilotArea = {
  id: "pine-ridge-pilot",
  name: "Pine Ridge",
  region: "Gdynia West, Pomerania, Poland (synthetic extent)",
  description:
    "A compact fictional woodland area for showing how a route can leave mapped paths when terrain data suggests a viable passage.",
  center: { ...SYNTHETIC_TERRAIN_CENTER },
  bounds: DEMO_BOUNDS,
  boundary: DEMO_BOUNDARY,
  coordinateOrder: "lat,lng",
  sourceId: "synthetic",
  isSynthetic: true,
};

export const DEFAULT_START_POINT: DemoPoint = {
  id: "west-meadow-access",
  label: "West meadow access",
  role: "start",
  coordinate: { lat: 54.449585, lng: 18.48365 },
  description: "A synthetic access point near the western edge of the pilot area.",
  sourceId: "synthetic",
  isSynthetic: true,
};

export const DEFAULT_END_POINT: DemoPoint = {
  id: "east-forest-overlook",
  label: "East forest overlook",
  role: "end",
  coordinate: { lat: 54.465332, lng: 18.534734 },
  description: "A synthetic destination near the eastern edge of the pilot area.",
  sourceId: "synthetic",
  isSynthetic: true,
};

/**
 * Illustrative mapped geometry only. These are not verified OSM ways and
 * should never be presented as proof that a path is open or safe to use.
 */
export const KNOWN_MAPPED_PATHS: MappedPath[] = [
  {
    id: "main-forest-trail",
    name: "Main forest trail",
    kind: "forest-trail",
    coordinates: [
      { lat: 54.449585, lng: 18.48365 },
      { lat: 54.452914, lng: 18.492938 },
      { lat: 54.456063, lng: 18.503619 },
      { lat: 54.459123, lng: 18.513836 },
      { lat: 54.462362, lng: 18.524362 },
      { lat: 54.465332, lng: 18.534734 },
    ],
    surface: "forest floor",
    description: "The main mapped forest trail crossing the synthetic terrain grid.",
    sourceId: "synthetic",
    isSynthetic: true,
  },
  {
    id: "ridge-trail",
    name: "Ridge trail",
    kind: "ridge-trail",
    coordinates: [
      { lat: 54.465242, lng: 18.485198 },
      { lat: 54.463622, lng: 18.494951 },
      { lat: 54.462992, lng: 18.505322 },
      { lat: 54.464252, lng: 18.515848 },
      { lat: 54.462722, lng: 18.533186 },
    ],
    surface: "dry forest floor",
    description: "A mapped trail following the higher ground through the pilot area.",
    sourceId: "synthetic",
    isSynthetic: true,
  },
  {
    id: "meadow-track",
    name: "Meadow track",
    kind: "meadow-track",
    coordinates: [
      { lat: 54.458853, lng: 18.48752 },
      { lat: 54.457503, lng: 18.494951 },
      { lat: 54.458493, lng: 18.503619 },
      { lat: 54.457683, lng: 18.512598 },
      { lat: 54.458223, lng: 18.520957 },
      { lat: 54.459843, lng: 18.530864 },
    ],
    surface: "short grass and soil",
    description: "A mapped track across the lower meadow portion of the grid.",
    sourceId: "synthetic",
    isSynthetic: true,
  },
];

export const TERRAIN_LAYER_LABELS: Record<TerrainLayerId, string> = {
  elevation: "Elevation",
  slope: "Slope",
  "land-cover": "Land cover",
  wetness: "Wetness",
};

export const TERRAIN_LAYERS: TerrainLayer[] = [
  {
    id: "elevation",
    label: TERRAIN_LAYER_LABELS.elevation,
    description: "Relative elevation values for the synthetic terrain surface.",
    unit: "relative metres",
    sourceId: "synthetic",
    intendedAdapter: "lidar",
    status: "synthetic",
    visibleByDefault: true,
  },
  {
    id: "slope",
    label: TERRAIN_LAYER_LABELS.slope,
    description: "Illustrative slope classes derived from the synthetic surface.",
    unit: "degrees",
    sourceId: "synthetic",
    intendedAdapter: "lidar",
    status: "synthetic",
    visibleByDefault: false,
  },
  {
    id: "land-cover",
    label: TERRAIN_LAYER_LABELS["land-cover"],
    description: "Illustrative forest, clearing, scrub, and wetland classes.",
    unit: "class",
    sourceId: "synthetic",
    intendedAdapter: "geoportal",
    status: "synthetic",
    visibleByDefault: false,
  },
  {
    id: "wetness",
    label: TERRAIN_LAYER_LABELS.wetness,
    description: "Illustrative wetness classes near synthetic stream and wetland corridors.",
    unit: "class",
    sourceId: "synthetic",
    intendedAdapter: "lidar",
    status: "synthetic",
    visibleByDefault: false,
  },
];

/**
 * Keep this string available for a map control or footer. If live OSM tiles
 * are enabled, the OSM attribution entry below must remain visible as well.
 */
export const SOURCE_ATTRIBUTION =
  "Pathless synthetic demo data · © OpenStreetMap contributors for the planned basemap adapter";

export const DATA_SOURCES: DataSourceAttribution[] = [
  {
    id: "synthetic",
    label: "Pathless synthetic fixture",
    attribution: "Pathless contributors",
    license: "MIT for the source code; fixture values are illustrative",
    status: "included",
    notes:
      "The checked-in boundary, points, paths, and terrain labels are hand-authored demo values, not survey data.",
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    attribution: "© OpenStreetMap contributors",
    url: "https://www.openstreetmap.org/copyright",
    license: "Open Database License (ODbL) 1.0",
    status: "planned",
    notes:
      "Intended for mapped ways and a basemap adapter; attribution, caching, and share-alike obligations must be reviewed before deployment.",
  },
  {
    id: "geoportal",
    label: "Polish Geoportal",
    attribution: "Geoportal.gov.pl / GUGiK",
    url: "https://www.geoportal.gov.pl/",
    license: "Dataset- and service-specific terms; verify before use",
    status: "planned",
    notes:
      "Intended for authoritative map, land-cover, and elevation services where an appropriate public endpoint is available.",
  },
  {
    id: "lidar",
    label: "LiDAR and elevation data",
    attribution: "Provider-specific attribution",
    url: "https://www.geoportal.gov.pl/",
    license: "Dataset-specific terms; verify before redistribution",
    status: "planned",
    notes:
      "Intended to provide elevation, slope, roughness, and wetness proxies after CRS and vertical-datum normalization.",
  },
];

export interface DemoMapView {
  center: Coordinate;
  zoom: number;
  minZoom: number;
  maxZoom: number;
}

export const DEMO_MAP_VIEW: DemoMapView = {
  center: PILOT_AREA.center,
  zoom: 13,
  minZoom: 11,
  maxZoom: 16,
};

/** UI-safe display defaults; routing cost and policy decisions belong to the engine. */
export const SYNTHETIC_TERRAIN_GRID = {
  bounds: DEMO_BOUNDS,
  cellSizeMeters: 50,
  valuesAreIllustrative: true,
} as const;

export const DEFAULT_MAP_CENTER = PILOT_AREA.center;
export const DEFAULT_MAP_ZOOM = DEMO_MAP_VIEW.zoom;

/** A single import for consumers that want the complete demo fixture. */
export const DEMO_DATA = {
  pilotArea: PILOT_AREA,
  boundary: DEMO_BOUNDARY,
  bounds: DEMO_BOUNDS,
  defaultStart: DEFAULT_START_POINT,
  defaultEnd: DEFAULT_END_POINT,
  knownMappedPaths: KNOWN_MAPPED_PATHS,
  terrainLayers: TERRAIN_LAYERS,
  terrainLayerLabels: TERRAIN_LAYER_LABELS,
  sources: DATA_SOURCES,
  sourceAttribution: SOURCE_ATTRIBUTION,
  mapView: DEMO_MAP_VIEW,
  terrainGrid: SYNTHETIC_TERRAIN_GRID,
} as const;

export type DemoData = typeof DEMO_DATA;

// Short aliases keep the fixture easy to consume while the UI/engine settles.
export const DEMO_AREA = PILOT_AREA;
export const DEFAULT_START = DEFAULT_START_POINT;
export const DEFAULT_END = DEFAULT_END_POINT;
export const MAPPED_PATHS = KNOWN_MAPPED_PATHS;
export const SOURCE_ATTRIBUTIONS = DATA_SOURCES;
export const demoData = DEMO_DATA;
