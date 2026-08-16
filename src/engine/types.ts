/**
 * Public types for the terrain-routing prototype.
 *
 * Coordinates are WGS84 latitude/longitude pairs.  Distances and elevations
 * in the engine are expressed in metres; times are expressed in minutes.
 */

export const SYNTHETIC_TERRAIN_CENTER = {
  lat: 54.458403,
  lng: 18.509192,
} as const;

export type Coordinate = {
  lat: number;
  lng: number;
};

export type RoutingMode =
  | "nearest-mapped-path"
  | "selected-destination"
  | "design-route";

/** Concise aliases for UI code that prefers the word "route". */
export type RouteMode = RoutingMode;

export type ActivityProfile = "walking" | "mtb";

export type RouteProfile = ActivityProfile;
export type RoutingProfile = ActivityProfile;

export type LandCover = "meadow" | "forest" | "wetland" | "water";

export type MappedPathKind =
  | "meadow-track"
  | "forest-trail"
  | "ridge-trail"
  | "none";

export type RouteObjective = "balanced" | "fastest" | "gentle" | "mapped";

export interface GeoBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface TerrainCell {
  readonly row: number;
  readonly column: number;
  readonly coordinate: Coordinate;
  readonly xMeters: number;
  readonly yMeters: number;
  readonly elevationMeters: number;
  /** Maximum local grade estimated from the four cardinal neighbours. */
  readonly slopeDegrees: number;
  /** A synthetic surface roughness score in [0, 1]. */
  readonly roughness: number;
  readonly landCover: LandCover;
  /** A traversal risk in [0, 1], rather than a binary water mask. */
  readonly waterRisk: number;
  readonly mappedPath: boolean;
  readonly mappedPathKind: MappedPathKind;
}

export interface TerrainSummary {
  readonly id: string;
  readonly name: string;
  readonly dataSource: "synthetic-local";
  readonly center: Coordinate;
  readonly bounds: GeoBounds;
  readonly rows: number;
  readonly columns: number;
  readonly cellSizeMeters: number;
  readonly assumptions: readonly string[];
}

export interface TerrainModel extends TerrainSummary {
  readonly cells: readonly TerrainCell[];
  cellAt(row: number, column: number): TerrainCell | undefined;
  cellAtCoordinate(coordinate: Coordinate): TerrainCell;
  nearestCell(
    coordinate: Coordinate,
    predicate?: (cell: TerrainCell) => boolean,
  ): TerrainCell;
  contains(coordinate: Coordinate): boolean;
  distanceToBoundaryMeters(coordinate: Coordinate): number;
}

/**
 * These are deliberately human-scale controls so they can be bound directly
 * to sliders in the demo UI.  All optional request values are normalized to
 * this complete shape before the search starts.
 */
export interface RoutingPreferences {
  /** Maximum comfortable grade before the search applies a steepness cost. */
  slopeTolerance: number;
  /** -1 avoids ascent, 0 is neutral, +1 accepts/rewards ascent. */
  ascentPreference: number;
  /** Soft route-level ascent target. `null` disables the budget cost. */
  ascentBudget: number | null;
  /** 0 ignores roughness, 1 strongly prefers smoother surfaces. */
  roughness: number;
  /** 0 ignores mapped-path evidence, 1 strongly prefers mapped paths. */
  pathPreference: number;
  /** 0 permits water when necessary, 1 makes water very expensive. */
  waterAvoidance: number;
}

export type RoutingPreferencesInput = Partial<RoutingPreferences>;

export interface RouteRequest {
  readonly mode: RoutingMode;
  readonly origin: Coordinate;
  /** Required for `selected-destination`; optional final point for design mode. */
  readonly destination?: Coordinate;
  /** Ordered intermediate points for `design-route`. */
  readonly waypoints?: readonly Coordinate[];
  readonly profile?: ActivityProfile;
  readonly preferences?: RoutingPreferencesInput;
  /** Number of objective-diverse routes to return. Defaults to three. */
  readonly alternatives?: number;
}

export interface NormalizedRouteRequest {
  readonly mode: RoutingMode;
  readonly origin: Coordinate;
  readonly destination?: Coordinate;
  readonly waypoints: readonly Coordinate[];
  readonly profile: ActivityProfile;
  readonly preferences: RoutingPreferences;
  readonly alternatives: number;
}

export interface RouteSegment {
  readonly from: Coordinate;
  readonly to: Coordinate;
  readonly distanceMeters: number;
  readonly elevationChangeMeters: number;
  readonly slopeDegrees: number;
  readonly estimatedTimeMinutes: number;
  readonly roughness: number;
  readonly waterRisk: number;
  readonly mappedPath: boolean;
  readonly mappedPathKind: MappedPathKind;
  readonly landCover: LandCover;
}

export interface EvidenceBreakdown {
  /** Share of route distance that follows a mapped-path cell. */
  readonly mappedPath: number;
  /** Coverage of the deterministic local terrain grid. */
  readonly terrainModel: number;
  /** Confidence in the synthetic elevation signal. */
  readonly elevation: number;
  /** Confidence in synthetic land-cover/surface classification. */
  readonly surface: number;
  /** Confidence that water risk is represented correctly. */
  readonly water: number;
  /** Share of route whose geometry is inferred away from mapped paths. */
  readonly inferred: number;
}

export interface RouteMetrics {
  readonly distanceMeters: number;
  readonly distanceKilometers: number;
  readonly ascentMeters: number;
  readonly descentMeters: number;
  readonly maxSlopeDegrees: number;
  readonly estimatedTimeMinutes: number;
  readonly mappedDistanceMeters: number;
  readonly unmappedDistanceMeters: number;
  readonly waterDistanceMeters: number;
  readonly averageRoughness: number;
  readonly confidence: number;
  readonly evidenceBreakdown: EvidenceBreakdown;
}

export interface RouteAlternative {
  readonly id: string;
  readonly objective: RouteObjective;
  readonly objectiveLabel: string;
  /** Internal objective score, useful for comparing alternatives. */
  readonly searchCost: number;
  readonly expandedNodes: number;
  /** Grid-backed WGS84 polyline, suitable for Leaflet or another map view. */
  readonly coordinates: readonly Coordinate[];
  readonly segments: readonly RouteSegment[];
  readonly metrics: RouteMetrics;
  /** Convenience alias for UIs that render evidence outside metrics. */
  readonly evidenceBreakdown: EvidenceBreakdown;
  readonly snappedOrigin: Coordinate;
  readonly snappedDestination?: Coordinate;
  readonly snappedWaypoints: readonly Coordinate[];
  readonly ascentBudgetExceeded: boolean;
}

export type RoutingIssueCode =
  | "invalid-request"
  | "outside-terrain"
  | "no-route";

export interface RoutingIssue {
  readonly code: RoutingIssueCode;
  readonly message: string;
}

export interface RoutingResult {
  readonly request: NormalizedRouteRequest;
  readonly routes: readonly RouteAlternative[];
  /** The first route is the recommended one for a UI default selection. */
  readonly primaryRoute?: RouteAlternative;
  readonly terrain: TerrainSummary;
  readonly snappedOrigin?: Coordinate;
  readonly snappedTargets: readonly Coordinate[];
  readonly warnings: readonly string[];
  readonly errors: readonly RoutingIssue[];
}

export interface SyntheticTerrainOptions {
  readonly center?: Coordinate;
  readonly rows?: number;
  readonly columns?: number;
  readonly cellSizeMeters?: number;
  readonly id?: string;
  readonly name?: string;
}

export interface TerrainRouterOptions {
  readonly terrain?: TerrainModel;
  readonly defaultPreferences?: RoutingPreferencesInput;
  readonly defaultProfile?: ActivityProfile;
  readonly maxAlternatives?: number;
}
