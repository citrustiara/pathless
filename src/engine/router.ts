import { createSyntheticTerrainModel } from "./terrain";
import {
  DEFAULT_ROUTING_PREFERENCES,
  evaluateEdge,
  objectiveSequence,
  OBJECTIVE_LABELS,
  searchGridPath,
} from "./search";
import {
  type ActivityProfile,
  type Coordinate,
  type EvidenceBreakdown,
  type RouteAlternative,
  type RouteMetrics,
  type RouteObjective,
  type RouteRequest,
  type RoutingIssue,
  type RoutingMode,
  type RoutingPreferences,
  type RoutingPreferencesInput,
  type RoutingResult,
  type NormalizedRouteRequest,
  SYNTHETIC_TERRAIN_CENTER,
  type TerrainCell,
  type TerrainModel,
  type TerrainRouterOptions,
} from "./types";

const MAX_ALTERNATIVES = 4;
const DEFAULT_ALTERNATIVES = 3;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const coordinateFromUnknown = (value: unknown): Coordinate | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as { lat?: unknown; lng?: unknown };
  if (
    typeof candidate.lat !== "number" ||
    typeof candidate.lng !== "number" ||
    !Number.isFinite(candidate.lat) ||
    !Number.isFinite(candidate.lng) ||
    candidate.lat < -90 ||
    candidate.lat > 90 ||
    candidate.lng < -180 ||
    candidate.lng > 180
  ) {
    return undefined;
  }

  return { lat: candidate.lat, lng: candidate.lng };
};

const modeFromUnknown = (value: unknown): RoutingMode | undefined => {
  switch (value) {
    case "nearest-mapped-path":
    case "nearest-mapped":
    case "nearestMappedPath":
      return "nearest-mapped-path";
    case "selected-destination":
    case "selectedDestination":
    case "destination":
      return "selected-destination";
    case "design-route":
    case "designRoute":
    case "waypoints":
      return "design-route";
    default:
      return undefined;
  }
};

const profileFromUnknown = (
  value: unknown,
  fallback: ActivityProfile,
): ActivityProfile => (value === "mtb" ? "mtb" : value === "walking" ? "walking" : fallback);

export const normalizeRoutingPreferences = (
  input: RoutingPreferencesInput = {},
  base: RoutingPreferences = DEFAULT_ROUTING_PREFERENCES,
): RoutingPreferences => {
  const rawBudget = input.ascentBudget;
  const ascentBudget =
    rawBudget === null
      ? null
      : rawBudget === undefined
        ? base.ascentBudget
        : Number.isFinite(rawBudget)
          ? Math.max(0, rawBudget)
          : base.ascentBudget;

  return {
    slopeTolerance: clamp(
      finiteOr(input.slopeTolerance, base.slopeTolerance),
      0,
      45,
    ),
    ascentPreference: clamp(
      finiteOr(input.ascentPreference, base.ascentPreference),
      -1,
      1,
    ),
    ascentBudget,
    roughness: clamp(finiteOr(input.roughness, base.roughness), 0, 1),
    pathPreference: clamp(
      finiteOr(input.pathPreference, base.pathPreference),
      0,
      1,
    ),
    waterAvoidance: clamp(
      finiteOr(input.waterAvoidance, base.waterAvoidance),
      0,
      1,
    ),
  };
};

export interface NormalizationResult {
  readonly request: NormalizedRouteRequest;
  readonly errors: readonly RoutingIssue[];
}

/** Normalize runtime input once so a UI can safely pass form values. */
export const normalizeRouteRequest = (
  input: RouteRequest,
  options: {
    readonly defaultPreferences?: RoutingPreferencesInput;
    readonly defaultProfile?: ActivityProfile;
    readonly maxAlternatives?: number;
  } = {},
): NormalizationResult => {
  const candidate = (input ?? {}) as Partial<RouteRequest>;
  const errors: RoutingIssue[] = [];
  const mode = modeFromUnknown(candidate.mode);
  const normalizedMode = mode ?? "selected-destination";
  if (mode === undefined) {
    errors.push({
      code: "invalid-request",
      message:
        "mode must be nearest-mapped-path, selected-destination, or design-route",
    });
  }

  const origin = coordinateFromUnknown(candidate.origin);
  if (origin === undefined) {
    errors.push({
      code: "invalid-request",
      message: "origin must be a finite WGS84 latitude/longitude coordinate",
    });
  }

  const normalizedOrigin = origin ?? { ...SYNTHETIC_TERRAIN_CENTER };
  const destination =
    candidate.destination === undefined
      ? undefined
      : coordinateFromUnknown(candidate.destination);
  if (candidate.destination !== undefined && destination === undefined) {
    errors.push({
      code: "invalid-request",
      message: "destination must be a finite WGS84 latitude/longitude coordinate",
    });
  }

  const rawWaypoints = Array.isArray(candidate.waypoints)
    ? candidate.waypoints
    : [];
  const waypoints: Coordinate[] = [];
  rawWaypoints.forEach((waypoint, index) => {
    const normalizedWaypoint = coordinateFromUnknown(waypoint);
    if (normalizedWaypoint === undefined) {
      errors.push({
        code: "invalid-request",
        message: `waypoint ${index + 1} must be a finite WGS84 latitude/longitude coordinate`,
      });
      return;
    }
    waypoints.push(normalizedWaypoint);
  });

  const fallbackProfile = options.defaultProfile ?? "walking";
  const profile = profileFromUnknown(candidate.profile, fallbackProfile);
  if (
    candidate.profile !== undefined &&
    candidate.profile !== "walking" &&
    candidate.profile !== "mtb"
  ) {
    errors.push({
      code: "invalid-request",
      message: "profile must be walking or mtb",
    });
  }

  const basePreferences = normalizeRoutingPreferences(
    options.defaultPreferences,
  );
  const preferences = normalizeRoutingPreferences(
    candidate.preferences ?? {},
    basePreferences,
  );

  const maxAlternatives = clamp(
    Math.round(finiteOr(options.maxAlternatives, MAX_ALTERNATIVES)),
    1,
    MAX_ALTERNATIVES,
  );
  const alternatives = clamp(
    Math.round(finiteOr(candidate.alternatives, DEFAULT_ALTERNATIVES)),
    1,
    maxAlternatives,
  );

  if (normalizedMode === "selected-destination" && destination === undefined) {
    errors.push({
      code: "invalid-request",
      message: "selected-destination mode requires destination",
    });
  }
  if (
    normalizedMode === "design-route" &&
    waypoints.length === 0 &&
    destination === undefined
  ) {
    errors.push({
      code: "invalid-request",
      message: "design-route mode requires at least one waypoint or destination",
    });
  }

  return {
    request: {
      mode: normalizedMode,
      origin: normalizedOrigin,
      destination,
      waypoints,
      profile,
      preferences,
      alternatives,
    },
    errors,
  };
};

interface PlanningTarget {
  readonly requested: Coordinate;
  readonly cell: TerrainCell;
}

interface BuiltRoute {
  readonly route: RouteAlternative;
  readonly nodeIndices: readonly number[];
  readonly warnings: readonly string[];
}

const appendPath = (combined: number[], path: readonly number[]): void => {
  if (path.length === 0) {
    return;
  }

  if (combined.length > 0 && combined[combined.length - 1] === path[0]) {
    combined.push(...path.slice(1));
  } else {
    combined.push(...path);
  }
};

const cellIndex = (terrain: TerrainModel, cell: TerrainCell): number =>
  cell.row * terrain.columns + cell.column;

const buildEvidence = (
  distanceMeters: number,
  mappedDistanceMeters: number,
  waterDistanceMeters: number,
  averageRoughness: number,
  maxSlopeDegrees: number,
): EvidenceBreakdown => {
  const mappedPath =
    distanceMeters > 0 ? clamp(mappedDistanceMeters / distanceMeters, 0, 1) : 0;
  const waterCoverage =
    distanceMeters > 0 ? clamp(waterDistanceMeters / distanceMeters, 0, 1) : 0;
  const terrainModel = 1;
  const elevation = clamp(0.9 - maxSlopeDegrees / 180, 0.58, 0.9);
  const surface = clamp(0.91 - averageRoughness * 0.32, 0.58, 0.91);
  const water = clamp(0.97 - waterCoverage * 0.7, 0.22, 0.97);

  return {
    mappedPath,
    terrainModel,
    elevation,
    surface,
    water,
    inferred: 1 - mappedPath,
  };
};

const buildMetrics = (
  segments: readonly RouteAlternative["segments"][number][],
  startCell: TerrainCell,
): RouteMetrics => {
  let distanceMeters = 0;
  let ascentMeters = 0;
  let descentMeters = 0;
  let maxSlopeDegrees = 0;
  let estimatedTimeMinutes = 0;
  let mappedDistanceMeters = 0;
  let waterDistanceMeters = 0;
  let roughnessWeighted = 0;

  for (const segment of segments) {
    distanceMeters += segment.distanceMeters;
    ascentMeters += Math.max(0, segment.elevationChangeMeters);
    descentMeters += Math.max(0, -segment.elevationChangeMeters);
    maxSlopeDegrees = Math.max(maxSlopeDegrees, segment.slopeDegrees);
    estimatedTimeMinutes += segment.estimatedTimeMinutes;
    if (segment.mappedPath) {
      mappedDistanceMeters += segment.distanceMeters;
    }
    waterDistanceMeters += segment.distanceMeters * segment.waterRisk;
    roughnessWeighted += segment.distanceMeters * segment.roughness;
  }

  const averageRoughness =
    distanceMeters > 0 ? roughnessWeighted / distanceMeters : startCell.roughness;
  const evidenceBreakdown = buildEvidence(
    distanceMeters,
    mappedDistanceMeters,
    waterDistanceMeters,
    averageRoughness,
    maxSlopeDegrees,
  );
  const confidence = clamp(
    0.22 +
      evidenceBreakdown.mappedPath * 0.25 +
      evidenceBreakdown.terrainModel * 0.12 +
      evidenceBreakdown.elevation * 0.16 +
      evidenceBreakdown.surface * 0.12 +
      evidenceBreakdown.water * 0.1 -
      evidenceBreakdown.inferred * 0.15 -
      averageRoughness * 0.06,
    0.05,
    0.97,
  );

  return {
    distanceMeters,
    distanceKilometers: distanceMeters / 1_000,
    ascentMeters,
    descentMeters,
    maxSlopeDegrees,
    estimatedTimeMinutes,
    mappedDistanceMeters,
    unmappedDistanceMeters: Math.max(0, distanceMeters - mappedDistanceMeters),
    waterDistanceMeters,
    averageRoughness,
    confidence,
    evidenceBreakdown,
  };
};

const makeSegments = (
  terrain: TerrainModel,
  indices: readonly number[],
  profile: ActivityProfile,
  preferences: RoutingPreferences,
  objective: RouteObjective,
): RouteAlternative["segments"] => {
  const segments: RouteAlternative["segments"][number][] = [];
  for (let index = 1; index < indices.length; index += 1) {
    const from = terrain.cells[indices[index - 1]];
    const to = terrain.cells[indices[index]];
    if (from === undefined || to === undefined) {
      continue;
    }
    const evaluation = evaluateEdge(from, to, profile, preferences, objective);
    segments.push({
      from: from.coordinate,
      to: to.coordinate,
      distanceMeters: evaluation.distanceMeters,
      elevationChangeMeters: evaluation.elevationChangeMeters,
      slopeDegrees: evaluation.slopeDegrees,
      estimatedTimeMinutes: evaluation.estimatedTimeSeconds / 60,
      roughness: evaluation.roughness,
      waterRisk: evaluation.waterRisk,
      mappedPath: evaluation.mappedPath,
      mappedPathKind: evaluation.mappedPathKind,
      landCover: evaluation.landCover,
    });
  }
  return segments;
};

const targetCoordinatesFor = (
  request: NormalizedRouteRequest,
  terrain: TerrainModel,
  originCell: TerrainCell,
): readonly PlanningTarget[] => {
  if (request.mode === "nearest-mapped-path") {
    const mappedCell = terrain.nearestCell(
      originCell.coordinate,
      (cell) => cell.mappedPath && cell.waterRisk < 0.75,
    );
    return [{ requested: mappedCell.coordinate, cell: mappedCell }];
  }

  const requestedCoordinates =
    request.mode === "selected-destination"
      ? request.destination === undefined
        ? []
        : [request.destination]
      : [
          ...request.waypoints,
          ...(request.destination === undefined ? [] : [request.destination]),
        ];

  return requestedCoordinates.map((requested) => ({
    requested,
    cell: terrain.cellAtCoordinate(requested),
  }));
};

const buildAlternative = (
  terrain: TerrainModel,
  request: NormalizedRouteRequest,
  objective: RouteObjective,
  routeIndex: number,
  originCell: TerrainCell,
  targets: readonly PlanningTarget[],
  discouragedNodes: ReadonlySet<number>,
): BuiltRoute | undefined => {
  const combinedIndices: number[] = [];
  let currentIndex = cellIndex(terrain, originCell);
  let totalSearchCost = 0;
  let expandedNodes = 0;

  for (const target of targets) {
    const targetIndex = cellIndex(terrain, target.cell);
    const path = searchGridPath({
      terrain,
      profile: request.profile,
      preferences: request.preferences,
      objective,
      discouragedNodes,
      startIndex: currentIndex,
      goalIndex: targetIndex,
    });
    if (path === undefined) {
      return undefined;
    }

    appendPath(combinedIndices, path.indices);
    currentIndex = targetIndex;
    totalSearchCost += path.cost;
    expandedNodes += path.expandedNodes;
  }

  const segments = makeSegments(
    terrain,
    combinedIndices,
    request.profile,
    request.preferences,
    objective,
  );
  const metrics = buildMetrics(segments, originCell);
  const id = `${objective}-${routeIndex + 1}`;
  const route: RouteAlternative = {
    id,
    objective,
    objectiveLabel: OBJECTIVE_LABELS[objective],
    searchCost: totalSearchCost,
    expandedNodes,
    coordinates: combinedIndices.map((index) => terrain.cells[index].coordinate),
    segments,
    metrics,
    evidenceBreakdown: metrics.evidenceBreakdown,
    snappedOrigin: originCell.coordinate,
    snappedDestination:
      targets.length > 0 ? targets[targets.length - 1].cell.coordinate : undefined,
    snappedWaypoints:
      request.mode === "design-route"
        ? targets.map((target) => target.cell.coordinate)
        : [],
    ascentBudgetExceeded:
      request.preferences.ascentBudget !== null &&
      metrics.ascentMeters > request.preferences.ascentBudget + 0.5,
  };

  const warnings: string[] = [];
  if (route.ascentBudgetExceeded) {
    warnings.push(
      `${route.objectiveLabel} route exceeds the soft ascent budget by ${Math.round(
        metrics.ascentMeters - (request.preferences.ascentBudget ?? 0),
      )} m`,
    );
  }
  if (metrics.waterDistanceMeters > 1 && request.preferences.waterAvoidance > 0.7) {
    warnings.push(
      `${route.objectiveLabel} route crosses synthetic water-risk cells because no dry path was cheaper`,
    );
  }

  return { route, nodeIndices: combinedIndices, warnings };
};

export class TerrainRouter {
  readonly terrain: TerrainModel;
  private readonly defaultPreferences: RoutingPreferences;
  private readonly defaultProfile: ActivityProfile;
  private readonly maxAlternatives: number;

  constructor(options: TerrainRouterOptions = {}) {
    this.terrain = options.terrain ?? createSyntheticTerrainModel();
    this.defaultPreferences = normalizeRoutingPreferences(
      options.defaultPreferences,
    );
    this.defaultProfile = options.defaultProfile ?? "walking";
    this.maxAlternatives = clamp(
      Math.round(finiteOr(options.maxAlternatives, MAX_ALTERNATIVES)),
      1,
      MAX_ALTERNATIVES,
    );
  }

  plan(input: RouteRequest): RoutingResult {
    const normalization = normalizeRouteRequest(input, {
      defaultPreferences: this.defaultPreferences,
      defaultProfile: this.defaultProfile,
      maxAlternatives: this.maxAlternatives,
    });
    const request = normalization.request;
    const errors = [...normalization.errors];

    if (errors.length > 0) {
      return {
        request,
        routes: [],
        primaryRoute: undefined,
        terrain: this.terrain,
        snappedOrigin: undefined,
        snappedTargets: [],
        warnings: [],
        errors,
      };
    }

    const warnings: string[] = [];
    if (!this.terrain.contains(request.origin)) {
      warnings.push(
        `Origin is ${Math.round(
          this.terrain.distanceToBoundaryMeters(request.origin),
        )} m outside the synthetic terrain; it was clamped to the nearest grid cell`,
      );
    }

    const originCell = this.terrain.cellAtCoordinate(request.origin);
    const targets = targetCoordinatesFor(request, this.terrain, originCell);
    for (const target of targets) {
      if (!this.terrain.contains(target.requested)) {
        warnings.push(
          `A target is outside the synthetic terrain; it was clamped to ${target.cell.coordinate.lat.toFixed(
            5,
          )}, ${target.cell.coordinate.lng.toFixed(5)}`,
        );
      }
    }

    const routes: RouteAlternative[] = [];
    const objectiveRoutes = objectiveSequence(request.alternatives);
    const usedNodes = new Set<number>();
    for (const [routeIndex, objective] of objectiveRoutes.entries()) {
      const built = buildAlternative(
        this.terrain,
        request,
        objective,
        routeIndex,
        originCell,
        targets,
        usedNodes,
      );
      if (built === undefined) {
        warnings.push(`${OBJECTIVE_LABELS[objective]} route could not be found`);
        continue;
      }

      routes.push(built.route);
      warnings.push(...built.warnings);
      for (const index of built.nodeIndices) {
        usedNodes.add(index);
      }
    }

    if (routes.length === 0) {
      errors.push({
        code: "no-route",
        message: "No traversable route was found across the synthetic terrain grid",
      });
    }

    return {
      request,
      routes,
      primaryRoute: routes[0],
      terrain: this.terrain,
      snappedOrigin: originCell.coordinate,
      snappedTargets: targets.map((target) => target.cell.coordinate),
      warnings: [...new Set(warnings)],
      errors,
    };
  }

  route(input: RouteRequest): RoutingResult {
    return this.plan(input);
  }

  findRoutes(input: RouteRequest): RoutingResult {
    return this.plan(input);
  }
}

export const createTerrainRouter = (
  options: TerrainRouterOptions = {},
): TerrainRouter => new TerrainRouter(options);

export const planRoute = (
  input: RouteRequest,
  options: TerrainRouterOptions = {},
): RoutingResult => createTerrainRouter(options).plan(input);

/** Functional alias convenient for a small React demo. */
export const route = planRoute;

export const findRoutes = planRoute;

export const getDefaultTerrainModel = (): TerrainModel =>
  createSyntheticTerrainModel();

export const DEFAULT_PROFILE: ActivityProfile = "walking";
