import type { ActivityProfile, Coordinate, OSMRoute } from "../engine";

export type AppMode = "nearest" | "destination" | "design";

export type ProfileId = ActivityProfile;

export type PlacementMode = "start" | "target" | "waypoint" | null;

/** A point on the map. Real coordinates, never screen or grid percentages. */
export type MapPoint = Coordinate & { label?: string };

/**
 * Everything the router is allowed to be told. Each entry is a limit or a
 * permission a person can check on the ground; nothing here is a vague
 * preference weight.
 */
export type RouteSettings = {
  /** Hard limit on the grade along the route, as a percentage. */
  maxGradePercent: number;
  /** How many minutes on a trail you would walk to avoid one minute off it. */
  offTrailAversion: number;
  /** Hard limit on any single unmapped stretch, in metres. */
  maxOffTrailMeters: number;
  allowStreetCrossing: boolean;
  allowStreetWalking: boolean;
  avoidWater: boolean;
  showAlternatives: boolean;
};

export type ElevationStatus = "loading" | "ready" | "unavailable";

export type RouteView = {
  status: "ready" | "blocked";
  title: string;
  subtitle: string;
  route?: OSMRoute;
  alternatives: OSMRoute[];
  notes: string[];
  blockedReason?: string;
};

export type RouteRequest = {
  mode: AppMode;
  profile: ProfileId;
  settings: RouteSettings;
  start: MapPoint;
  target: MapPoint;
  waypoints: MapPoint[];
};
