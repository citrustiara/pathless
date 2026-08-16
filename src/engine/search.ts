import { distanceBetweenCoordinates } from "./terrain";
import {
  type ActivityProfile,
  type MappedPathKind,
  type RouteObjective,
  type RoutingPreferences,
  type TerrainCell,
  type TerrainModel,
} from "./types";

export const DEFAULT_ROUTING_PREFERENCES: RoutingPreferences = {
  slopeTolerance: 14,
  ascentPreference: 0,
  ascentBudget: null,
  roughness: 0.45,
  pathPreference: 0.55,
  waterAvoidance: 0.9,
};

export const OBJECTIVE_LABELS: Record<RouteObjective, string> = {
  balanced: "Balanced",
  fastest: "Fastest",
  gentle: "Gentlest",
  mapped: "Mapped-path evidence",
};

interface ObjectiveWeights {
  readonly time: number;
  readonly slope: number;
  readonly ascent: number;
  readonly roughness: number;
  readonly path: number;
  readonly water: number;
}

const OBJECTIVE_WEIGHTS: Record<RouteObjective, ObjectiveWeights> = {
  balanced: {
    time: 1,
    slope: 1,
    ascent: 1,
    roughness: 1,
    path: 1,
    water: 1,
  },
  fastest: {
    time: 1.3,
    slope: 0.58,
    ascent: 0.58,
    roughness: 0.45,
    path: 0.5,
    water: 0.8,
  },
  gentle: {
    time: 1,
    slope: 2.6,
    ascent: 1.9,
    roughness: 1.25,
    path: 0.7,
    water: 1.05,
  },
  mapped: {
    time: 1.04,
    slope: 0.9,
    ascent: 0.8,
    roughness: 0.72,
    path: 3.5,
    water: 1,
  },
};

export interface EdgeEvaluation {
  readonly distanceMeters: number;
  readonly elevationChangeMeters: number;
  readonly ascentMeters: number;
  readonly descentMeters: number;
  readonly slopeDegrees: number;
  readonly estimatedTimeSeconds: number;
  readonly roughness: number;
  readonly waterRisk: number;
  readonly mappedPath: boolean;
  readonly mappedPathKind: MappedPathKind;
  readonly landCover: TerrainCell["landCover"];
  readonly cost: number;
}

export interface GridSearchOptions {
  readonly terrain: TerrainModel;
  readonly profile: ActivityProfile;
  readonly preferences: RoutingPreferences;
  readonly objective: RouteObjective;
  /** Nodes used by earlier alternatives receive a deterministic soft penalty. */
  readonly discouragedNodes?: ReadonlySet<number>;
  readonly startIndex: number;
  readonly goalIndex: number;
}

export interface GridSearchResult {
  readonly indices: readonly number[];
  readonly cost: number;
  readonly expandedNodes: number;
}

interface HeapEntry {
  readonly index: number;
  readonly priority: number;
  readonly cost: number;
}

class MinHeap {
  private readonly values: HeapEntry[] = [];

  get length(): number {
    return this.values.length;
  }

  push(value: HeapEntry): void {
    this.values.push(value);
    this.bubbleUp(this.values.length - 1);
  }

  pop(): HeapEntry | undefined {
    if (this.values.length === 0) {
      return undefined;
    }

    const first = this.values[0];
    const last = this.values.pop();
    if (last !== undefined && this.values.length > 0) {
      this.values[0] = last;
      this.bubbleDown(0);
    }

    return first;
  }

  private bubbleUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[parent], this.values[index]) <= 0) {
        break;
      }
      [this.values[parent], this.values[index]] = [
        this.values[index],
        this.values[parent],
      ];
      index = parent;
    }
  }

  private bubbleDown(startIndex: number): void {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;

      if (
        left < this.values.length &&
        this.compare(this.values[left], this.values[smallest]) < 0
      ) {
        smallest = left;
      }
      if (
        right < this.values.length &&
        this.compare(this.values[right], this.values[smallest]) < 0
      ) {
        smallest = right;
      }
      if (smallest === index) {
        break;
      }

      [this.values[index], this.values[smallest]] = [
        this.values[smallest],
        this.values[index],
      ];
      index = smallest;
    }
  }

  private compare(a: HeapEntry, b: HeapEntry): number {
    return a.priority - b.priority || a.index - b.index;
  }
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const squared = (value: number): number => value * value;

const profileParameters: Record<
  ActivityProfile,
  { readonly baseSpeedMetersPerSecond: number; readonly slopeFactor: number; readonly roughnessFactor: number }
> = {
  walking: {
    baseSpeedMetersPerSecond: 1.35,
    slopeFactor: 1.18,
    roughnessFactor: 0.62,
  },
  mtb: {
    baseSpeedMetersPerSecond: 4.15,
    slopeFactor: 0.9,
    roughnessFactor: 0.96,
  },
};

const indexParts = (
  terrain: TerrainModel,
  index: number,
): { row: number; column: number } => ({
  row: Math.floor(index / terrain.columns),
  column: index % terrain.columns,
});

const localDistanceBetweenCells = (a: TerrainCell, b: TerrainCell): number =>
  Math.hypot(a.xMeters - b.xMeters, a.yMeters - b.yMeters);

/**
 * Evaluate one grid edge against the active objective and user controls.
 * The cost remains non-negative and is measured in time-like units so A* can
 * use a straight-line travel-time lower bound as its heuristic.
 */
export const evaluateEdge = (
  from: TerrainCell,
  to: TerrainCell,
  profile: ActivityProfile,
  preferences: RoutingPreferences,
  objective: RouteObjective,
  diversityPenalty = 0,
): EdgeEvaluation => {
  const weights = OBJECTIVE_WEIGHTS[objective];
  const parameters = profileParameters[profile];
  const distanceMeters = localDistanceBetweenCells(from, to);
  const elevationChangeMeters = to.elevationMeters - from.elevationMeters;
  const ascentMeters = Math.max(0, elevationChangeMeters);
  const descentMeters = Math.max(0, -elevationChangeMeters);
  const slopeDegrees =
    (Math.atan2(Math.abs(elevationChangeMeters), distanceMeters) * 180) /
    Math.PI;
  const roughness = (from.roughness + to.roughness) / 2;
  const waterRisk = Math.max(from.waterRisk, to.waterRisk);
  const mappedPath = from.mappedPath || to.mappedPath;
  const mappedPathKind = from.mappedPath
    ? from.mappedPathKind
    : to.mappedPath
      ? to.mappedPathKind
      : "none";
  const landCover = waterRisk > 0.7
    ? "water"
    : from.landCover === "wetland" || to.landCover === "wetland"
      ? "wetland"
      : from.landCover === "forest" || to.landCover === "forest"
        ? "forest"
        : "meadow";

  const grade = Math.abs(elevationChangeMeters) / Math.max(distanceMeters, 1);
  const uphillTimeFactor =
    1 +
    parameters.slopeFactor * clamp(grade / 0.35, 0, 1.8) +
    (profile === "walking" ? 0.15 : 0.08) * clamp(ascentMeters / distanceMeters, 0, 1);
  const downhillTimeFactor =
    1 + (descentMeters > 0 ? 0.1 * clamp(descentMeters / distanceMeters, 0, 0.8) : 0);
  const roughnessTimeFactor = 1 + roughness * parameters.roughnessFactor;
  const waterTimeFactor = 1 + waterRisk * (profile === "mtb" ? 1.8 : 1.2);
  const estimatedTimeSeconds =
    (distanceMeters / parameters.baseSpeedMetersPerSecond) *
    uphillTimeFactor *
    downhillTimeFactor *
    roughnessTimeFactor *
    waterTimeFactor;

  const excessSlope = Math.max(0, slopeDegrees - preferences.slopeTolerance);
  const slopePenalty =
    distanceMeters *
    squaredNormalized(excessSlope, 18) *
    (profile === "walking" ? 1.7 : 1.35) *
    weights.slope;

  const ascentPreferenceFactor = clamp(
    0.85 - preferences.ascentPreference * 0.55,
    0.12,
    1.45,
  );
  const ascentPenalty =
    ascentMeters * 1.6 * ascentPreferenceFactor * weights.ascent;

  // A budget is intentionally soft: a local grid does not know the user's
  // final trip length until all waypoint legs are joined.  Raising the per-
  // ascent cost as the budget shrinks gives the user a predictable trade-off,
  // while the final route reports whether the aggregate budget was exceeded.
  const budgetPressure =
    preferences.ascentBudget === null
      ? 0
      : clamp(110 / Math.max(preferences.ascentBudget, 1), 0.06, 5.5);
  const ascentBudgetPenalty = ascentMeters * budgetPressure * weights.ascent;

  const roughnessPenalty =
    distanceMeters * roughness * preferences.roughness * 0.72 * weights.roughness;

  const pathAdjustment =
    distanceMeters *
    preferences.pathPreference *
    weights.path *
    (mappedPath ? -0.13 : 0.075);

  const waterPenalty =
    distanceMeters *
    waterRisk *
    (0.8 + preferences.waterAvoidance * 10.5) *
    weights.water *
    (waterRisk > 0.82 ? 2.2 : 1);

  const cost = Math.max(
    0.001,
    estimatedTimeSeconds * weights.time +
      slopePenalty +
      ascentPenalty +
      ascentBudgetPenalty +
      roughnessPenalty +
      pathAdjustment +
      waterPenalty +
      diversityPenalty,
  );

  return {
    distanceMeters,
    elevationChangeMeters,
    ascentMeters,
    descentMeters,
    slopeDegrees,
    estimatedTimeSeconds,
    roughness,
    waterRisk,
    mappedPath,
    mappedPathKind,
    landCover,
    cost,
  };
};

const squaredNormalized = (value: number, scale: number): number =>
  squared(value / Math.max(scale, 0.001));

const heuristic = (
  current: TerrainCell,
  goal: TerrainCell,
  profile: ActivityProfile,
  objective: RouteObjective,
): number => {
  const speed = profileParameters[profile].baseSpeedMetersPerSecond;
  // The 0.35 factor keeps this a conservative lower bound even when a mapped
  // corridor reduces cost or a route benefits from a user ascent preference.
  return (
    (distanceBetweenCoordinates(current.coordinate, goal.coordinate) / speed) *
    OBJECTIVE_WEIGHTS[objective].time *
    0.35
  );
};

const neighboursOf = (
  terrain: TerrainModel,
  index: number,
): readonly number[] => {
  const { row, column } = indexParts(terrain, index);
  const neighbours: number[] = [];

  for (let rowOffset = -1; rowOffset <= 1; rowOffset += 1) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset += 1) {
      if (rowOffset === 0 && columnOffset === 0) {
        continue;
      }

      const neighbour = terrain.cellAt(row + rowOffset, column + columnOffset);
      if (neighbour !== undefined) {
        neighbours.push(neighbour.row * terrain.columns + neighbour.column);
      }
    }
  }

  return neighbours;
};

/** A* over every cell in the synthetic terrain grid. */
export const searchGridPath = (
  options: GridSearchOptions,
): GridSearchResult | undefined => {
  const { terrain, startIndex, goalIndex } = options;
  const start = terrain.cells[startIndex];
  const goal = terrain.cells[goalIndex];
  if (start === undefined || goal === undefined) {
    return undefined;
  }

  if (startIndex === goalIndex) {
    return { indices: [startIndex], cost: 0, expandedNodes: 0 };
  }

  const distances = new Float64Array(terrain.cells.length);
  distances.fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(terrain.cells.length);
  cameFrom.fill(-1);
  const open = new MinHeap();
  distances[startIndex] = 0;
  open.push({
    index: startIndex,
    cost: 0,
    priority: heuristic(start, goal, options.profile, options.objective),
  });

  let expandedNodes = 0;
  while (open.length > 0) {
    const entry = open.pop();
    if (entry === undefined || entry.cost > distances[entry.index] + 1e-7) {
      continue;
    }

    if (entry.index === goalIndex) {
      const indices: number[] = [];
      let current = goalIndex;
      while (current !== -1) {
        indices.push(current);
        current = cameFrom[current];
      }
      indices.reverse();
      return { indices, cost: distances[goalIndex], expandedNodes };
    }

    expandedNodes += 1;
    for (const neighbourIndex of neighboursOf(terrain, entry.index)) {
      const from = terrain.cells[entry.index];
      const to = terrain.cells[neighbourIndex];
      if (from === undefined || to === undefined) {
        continue;
      }

      const diversityPenalty =
        options.discouragedNodes?.has(neighbourIndex) &&
        neighbourIndex !== goalIndex
          ? localDistanceBetweenCells(from, to) * 2.8
          : 0;
      const evaluation = evaluateEdge(
        from,
        to,
        options.profile,
        options.preferences,
        options.objective,
        diversityPenalty,
      );
      const tentativeDistance = distances[entry.index] + evaluation.cost;
      if (tentativeDistance + 1e-7 >= distances[neighbourIndex]) {
        continue;
      }

      cameFrom[neighbourIndex] = entry.index;
      distances[neighbourIndex] = tentativeDistance;
      open.push({
        index: neighbourIndex,
        cost: tentativeDistance,
        priority:
          tentativeDistance +
          heuristic(to, goal, options.profile, options.objective),
      });
    }
  }

  return undefined;
};

export const objectiveSequence = (count: number): readonly RouteObjective[] => {
  const sequence: readonly RouteObjective[] = [
    "balanced",
    "fastest",
    "gentle",
    "mapped",
  ];
  return sequence.slice(0, clamp(Math.round(count), 1, sequence.length));
};
