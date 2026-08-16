export type AppMode = "nearest" | "destination" | "design";

export type ProfileId = "hiker" | "runner" | "all-terrain";

export type PlacementMode = "start" | "target" | "waypoint" | null;

export type MapPoint = {
  x: number;
  y: number;
  label?: string;
};

export type RouteSettings = {
  slope: number;
  ascent: number;
  roughness: number;
  pathPreference: number;
  allowWater: boolean;
  alternatives: boolean;
};

export type SurfaceShare = {
  label: string;
  value: number;
  color: "blue" | "orange" | "green" | "slate";
};

export type RouteGeometry = {
  coordinates: Array<[number, number]>;
  coordinateOrder: "lon-lat" | "lat-lon";
};

export type RouteResult = {
  title: string;
  subtitle: string;
  distanceKm: number;
  durationMin: number;
  elevationGainM: number;
  elevationLossM: number;
  maxSlopePct: number;
  confidence: number;
  sourceLabel: string;
  routePath: MapPoint[];
  alternatives: MapPoint[][];
  geometry?: RouteGeometry;
  surface: SurfaceShare[];
  notes: string[];
};

export type RouteRequest = {
  mode: AppMode;
  profile: ProfileId;
  start: MapPoint;
  target: MapPoint;
  waypoints: MapPoint[];
  settings: RouteSettings;
};

