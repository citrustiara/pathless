/**
 * Routing over the imported OSM network, joined by terrain connectors.
 *
 * The cost of every metre is *estimated travel time*, derived from real
 * elevation via a normalised Tobler hiking curve and from the way's own OSM
 * surface tags. There is no invented "roughness" term: what the engine cannot
 * measure, it does not score.
 */
import {
  clamp,
  distanceBetweenCoordinates,
  interpolateCoordinate,
  pointDistanceToSegment,
  segmentIntersection,
  segmentsParallel,
} from "./geo";
import type { ActivityProfile, Coordinate, TerrainCell, TerrainModel } from "./types";
import { SOPOCKA_OSM_WAYS, type OSMFeature } from "../data/sopocka";

export type OSMRouteMode = "nearest" | "destination" | "design";

export type OSMRoutingRequest = {
  mode: OSMRouteMode;
  origin: Coordinate;
  destination?: Coordinate;
  waypoints: readonly Coordinate[];
  profile: ActivityProfile;
  /** Hard limit on the grade *along the route*, as a percentage. */
  maxGradePercent: number;
  /** Cost multiplier applied to time spent off mapped ways. 1 = indifferent. */
  offTrailAversion: number;
  /** Hard limit on any single unmapped stretch, in metres. */
  maxOffTrailMeters: number;
  /** Allow leaving a mapped way to cross a street anywhere. */
  allowStreetCrossing: boolean;
  /** Allow using a carriageway without a mapped footway as the walking surface. */
  allowStreetWalking: boolean;
  /** Refuse segments that run through a mapped watercourse. */
  avoidWater: boolean;
  alternatives: number;
};

export type OSMRouteSegment = {
  from: Coordinate;
  to: Coordinate;
  distanceMeters: number;
  elevationChangeMeters: number;
  /** Signed grade along the segment, as a fraction (0.1 = 10%). */
  grade: number;
  estimatedTimeMinutes: number;
  waterRisk: number;
  mappedPath: boolean;
  highway?: string;
  surfaceLabel: SurfaceClass;
  wayName?: string;
};

export type SurfaceClass =
  | "paved"
  | "gravel"
  | "natural-trail"
  | "steps"
  | "open-terrain";

export type ElevationSample = {
  distanceMeters: number;
  elevationMeters: number;
  grade: number;
  mappedPath: boolean;
};

export type OSMRoute = {
  id: string;
  objective: RouteFlavor;
  objectiveLabel: string;
  coordinates: Coordinate[];
  segments: OSMRouteSegment[];
  samples: ElevationSample[];
  distanceMeters: number;
  ascentMeters: number;
  descentMeters: number;
  maxGrade: number;
  estimatedTimeMinutes: number;
  mappedDistanceMeters: number;
  offTrailDistanceMeters: number;
  longestOffTrailMeters: number;
  waterDistanceMeters: number;
  surfaceBreakdown: Array<{ surface: SurfaceClass; distanceMeters: number }>;
  wayNames: string[];
  confidence: number;
  snappedDestination?: Coordinate;
};

export type OSMRoutingResult = {
  routes: OSMRoute[];
  warnings: string[];
  errors: string[];
};

type GraphEdge = {
  to: number;
  distanceMeters: number;
  mappedPath: boolean;
  street: boolean;
  walkway: boolean;
  bridge: boolean;
  tunnel: boolean;
  /** This edge sits right next to where its mapped way touches a road mid-way, not at its own end. */
  crossesStreet: boolean;
  highway?: string;
  surface: SurfaceClass;
  name?: string;
};

type GraphNode = {
  coordinate: Coordinate;
  edges: GraphEdge[];
  pathEvidence: boolean;
};

type RoadSegment = {
  from: Coordinate;
  to: Coordinate;
  feature: OSMFeature;
};

type Graph = {
  nodes: GraphNode[];
  nodeByKey: Map<string, number>;
  nodeIndex: Map<string, number[]>;
  roadSegments: RoadSegment[];
  roadIndex: Map<string, RoadSegment[]>;
  crossingPoints: Coordinate[];
  crossingIndex: Map<string, Coordinate[]>;
};

type SearchPath = {
  nodeIds: number[];
  edges: GraphEdge[];
  startConnector: Coordinate[];
  endConnector?: Coordinate[];
};

export type RouteFlavor = "balanced" | "direct" | "mapped";

type PathProfile = {
  distanceMeters: number;
  elevationChangeMeters: number;
  ascentMeters: number;
  descentMeters: number;
  maxGrade: number;
  timeMinutes: number;
  waterRisk: number;
  sideSlopeDegrees: number;
};

const MAX_CONNECTOR_NODES = 24;
const MAX_NEAREST_PATH_NODES = 64;
const SAMPLE_SPACING_METERS = 18;
const SPATIAL_BUCKET_DEGREES = 0.001;
const ROAD_CROSSING_TOLERANCE_METERS = 24;

/** Flat-ground speed in km/h before grade and surface are applied. */
const FLAT_SPEED_KMH: Record<ActivityProfile, number> = {
  hiker: 4.6,
  runner: 7.6,
  mtb: 12,
};

/** Multiplier on flat speed for each surface class, per travel style. */
const SURFACE_SPEED: Record<SurfaceClass, Record<ActivityProfile, number>> = {
  paved: { hiker: 1, runner: 1.05, mtb: 1.2 },
  gravel: { hiker: 0.97, runner: 0.95, mtb: 1 },
  "natural-trail": { hiker: 0.92, runner: 0.84, mtb: 0.78 },
  steps: { hiker: 0.42, runner: 0.34, mtb: 0.14 },
  "open-terrain": { hiker: 0.58, runner: 0.44, mtb: 0.3 },
};

export const SURFACE_LABELS: Record<SurfaceClass, string> = {
  paved: "Paved",
  gravel: "Gravel or compacted",
  "natural-trail": "Natural trail",
  steps: "Steps",
  "open-terrain": "Open terrain",
};

const coordinateKey = (coordinate: Coordinate): string =>
  `${coordinate.lat.toFixed(6)},${coordinate.lng.toFixed(6)}`;

const lower = (value: string | undefined): string => value?.trim().toLowerCase() ?? "";

const isPathEvidence = (feature: OSMFeature): boolean =>
  feature.category === "path" || feature.highway === "track";

const isStreetFeature = (feature: OSMFeature): boolean =>
  feature.category === "road" && feature.highway !== "track";

const hasWalkwayEvidence = (feature: OSMFeature): boolean => {
  if (feature.category === "path" || feature.highway === "track") return true;
  // `foot=yes` only permits the carriageway; it is not a separated walkway.
  return [feature.sidewalk, feature.sidewalkLeft, feature.sidewalkRight]
    .map(lower)
    .some((value) => ["yes", "both", "left", "right", "separate"].includes(value));
};

/** Ways the public may not legally use on foot. */
const isAccessRestricted = (feature: OSMFeature): boolean => {
  const foot = lower(feature.foot);
  if (["yes", "designated", "permissive", "destination"].includes(foot)) return false;
  if (foot === "no" || foot === "private") return true;
  return ["private", "no"].includes(lower(feature.access));
};

const surfaceClassFor = (feature: OSMFeature): SurfaceClass => {
  if (feature.highway === "steps") return "steps";
  const surface = lower(feature.surface);
  if (surface) {
    if (["asphalt", "concrete", "paving_stones", "paved", "sett", "cobblestone", "metal", "wood"].some((value) => surface.includes(value))) {
      return "paved";
    }
    if (["gravel", "compacted", "fine_gravel", "pebblestone", "rock", "unpaved"].some((value) => surface.includes(value))) {
      return "gravel";
    }
    return "natural-trail";
  }
  const tracktype = lower(feature.tracktype);
  if (tracktype === "grade1") return "paved";
  if (tracktype === "grade2" || tracktype === "grade3") return "gravel";
  if (tracktype) return "natural-trail";
  if (feature.category === "road") return "paved";
  return "natural-trail";
};

const featureLayer = (feature: OSMFeature): number => {
  const parsed = Number(feature.layer);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isBridgeOrTunnel = (feature: OSMFeature): boolean =>
  Boolean(lower(feature.bridge) || lower(feature.tunnel));

const bucketKey = (coordinate: Coordinate): string =>
  `${Math.floor(coordinate.lat / SPATIAL_BUCKET_DEGREES)}:${Math.floor(coordinate.lng / SPATIAL_BUCKET_DEGREES)}`;

const bucketKeysForBounds = (
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
): string[] => {
  const keys: string[] = [];
  const startLat = Math.floor(minLat / SPATIAL_BUCKET_DEGREES);
  const endLat = Math.floor(maxLat / SPATIAL_BUCKET_DEGREES);
  const startLng = Math.floor(minLng / SPATIAL_BUCKET_DEGREES);
  const endLng = Math.floor(maxLng / SPATIAL_BUCKET_DEGREES);
  for (let lat = startLat; lat <= endLat; lat += 1) {
    for (let lng = startLng; lng <= endLng; lng += 1) keys.push(`${lat}:${lng}`);
  }
  return keys;
};

const segmentBounds = (from: Coordinate, to: Coordinate, padding = 0): string[] =>
  bucketKeysForBounds(
    Math.min(from.lat, to.lat) - padding,
    Math.max(from.lat, to.lat) + padding,
    Math.min(from.lng, to.lng) - padding,
    Math.max(from.lng, to.lng) + padding,
  );

const addToIndex = <T>(index: Map<string, T[]>, key: string, value: T): void => {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
};

const graphNodeFor = (graph: Graph, coordinate: Coordinate): number => {
  const key = coordinateKey(coordinate);
  const existing = graph.nodeByKey.get(key);
  if (existing !== undefined) return existing;

  const id = graph.nodes.length;
  graph.nodes.push({ coordinate, edges: [], pathEvidence: false });
  graph.nodeByKey.set(key, id);
  addToIndex(graph.nodeIndex, bucketKey(coordinate), id);
  return id;
};

const addGraphEdge = (
  graph: Graph,
  from: number,
  to: number,
  feature: OSMFeature,
  crossesStreet = false,
): void => {
  if (from === to) return;
  const source = graph.nodes[from];
  const target = graph.nodes[to];
  if (!source || !target) return;

  const distanceMeters = distanceBetweenCoordinates(source.coordinate, target.coordinate);
  if (distanceMeters < 0.5) return;
  const mappedPath = isPathEvidence(feature);
  source.edges.push({
    to,
    distanceMeters,
    mappedPath,
    street: isStreetFeature(feature),
    walkway: hasWalkwayEvidence(feature),
    bridge: lower(feature.bridge).length > 0,
    tunnel: lower(feature.tunnel).length > 0,
    crossesStreet,
    highway: feature.highway,
    surface: surfaceClassFor(feature),
    name: feature.name,
  });
  source.pathEvidence ||= mappedPath;
  target.pathEvidence ||= mappedPath;
};

const buildSegmentIndex = (segments: RoadSegment[]): Map<string, RoadSegment[]> => {
  const index = new Map<string, RoadSegment[]>();
  for (const segment of segments) {
    for (const key of segmentBounds(segment.from, segment.to)) addToIndex(index, key, segment);
  }
  return index;
};

const buildPointIndex = (points: Coordinate[]): Map<string, Coordinate[]> => {
  const index = new Map<string, Coordinate[]>();
  for (const point of points) addToIndex(index, bucketKey(point), point);
  return index;
};

const roadCandidatesForLine = (
  graph: Graph,
  from: Coordinate,
  to: Coordinate,
): RoadSegment[] | undefined => {
  let candidates: Set<RoadSegment> | undefined;
  for (const key of segmentBounds(from, to, 0.00015)) {
    const bucketSegments = graph.roadIndex.get(key);
    if (!bucketSegments || bucketSegments.length === 0) continue;
    if (!candidates) candidates = new Set<RoadSegment>();
    for (const segment of bucketSegments) candidates.add(segment);
  }
  if (!candidates) return undefined;
  return [...candidates];
};

const crossingCandidatesNear = (graph: Graph, point: Coordinate): Coordinate[] => {
  const candidates = new Set<Coordinate>();
  for (const key of bucketKeysForBounds(
    point.lat - 0.0004,
    point.lat + 0.0004,
    point.lng - 0.0004,
    point.lng + 0.0004,
  )) {
    for (const crossing of graph.crossingIndex.get(key) ?? []) candidates.add(crossing);
  }
  return [...candidates];
};

/** A way OSM tags as an actual pedestrian crossing, not merely a point that touches a road. */
const isTaggedCrossing = (feature: OSMFeature): boolean => lower(feature.crossing).length > 0;

const deriveCrossingPoints = (
  pathSegments: RoadSegment[],
  roadIndex: Map<string, RoadSegment[]>,
): Coordinate[] => {
  const points: Coordinate[] = [];
  const seen = new Set<string>();
  for (const pathSegment of pathSegments) {
    const candidates = new Set<RoadSegment>();
    for (const key of segmentBounds(pathSegment.from, pathSegment.to, 0.00005)) {
      for (const road of roadIndex.get(key) ?? []) candidates.add(road);
    }
    for (const road of candidates) {
      // A path merely touching a road in the imported data is not evidence
      // anyone may cross there; only a way OSM tags as a crossing counts.
      if (!isTaggedCrossing(pathSegment.feature) && !isTaggedCrossing(road.feature)) continue;
      // A bridge or underpass only counts as a crossing if the layers agree.
      if (isBridgeOrTunnel(pathSegment.feature) !== isBridgeOrTunnel(road.feature) &&
          featureLayer(pathSegment.feature) !== featureLayer(road.feature)) continue;
      const point = segmentIntersection(pathSegment.from, pathSegment.to, road.from, road.to);
      if (!point) continue;
      const key = coordinateKey(point);
      if (!seen.has(key)) {
        seen.add(key);
        points.push(point);
      }
    }
  }
  return points;
};

const buildGraph = (features: readonly OSMFeature[]): Graph => {
  const graph: Graph = {
    nodes: [],
    nodeByKey: new Map(),
    nodeIndex: new Map(),
    roadSegments: [],
    roadIndex: new Map(),
    crossingPoints: [],
    crossingIndex: new Map(),
  };
  const pathSegments: RoadSegment[] = [];

  // A mapped path that touches a road *mid-way through its own geometry*
  // (not at its own start or end) physically crosses that road there; the
  // edges either side of that touch are flagged below so they get the same
  // permission check as an off-trail crossing. A path that merely starts or
  // ends at a road is an ordinary junction, not a crossing.
  const roadCoordinateKeys = new Set<string>();
  for (const feature of features) {
    if (!isStreetFeature(feature) || isAccessRestricted(feature)) continue;
    for (const [lat, lng] of feature.coordinates) roadCoordinateKeys.add(coordinateKey({ lat, lng }));
  }

  for (const feature of features) {
    if (isAccessRestricted(feature)) continue;
    const nodeIds = feature.coordinates.map((coordinate) => {
      const id = graphNodeFor(graph, { lat: coordinate[0], lng: coordinate[1] });
      if (isPathEvidence(feature)) graph.nodes[id].pathEvidence = true;
      return id;
    });
    const interiorRoadTouch = feature.coordinates.map((coordinate, index) =>
      isPathEvidence(feature) && index > 0 && index < feature.coordinates.length - 1 &&
      roadCoordinateKeys.has(coordinateKey({ lat: coordinate[0], lng: coordinate[1] })));
    for (let index = 1; index < nodeIds.length; index += 1) {
      const crossesStreet = interiorRoadTouch[index - 1] || interiorRoadTouch[index];
      addGraphEdge(graph, nodeIds[index - 1], nodeIds[index], feature, crossesStreet);
      addGraphEdge(graph, nodeIds[index], nodeIds[index - 1], feature, crossesStreet);
      const segment = {
        from: { lat: feature.coordinates[index - 1][0], lng: feature.coordinates[index - 1][1] },
        to: { lat: feature.coordinates[index][0], lng: feature.coordinates[index][1] },
        feature,
      };
      if (isStreetFeature(feature)) graph.roadSegments.push(segment);
      if (isPathEvidence(feature)) pathSegments.push(segment);
    }
  }

  graph.roadIndex = buildSegmentIndex(graph.roadSegments);
  graph.crossingPoints = deriveCrossingPoints(pathSegments, graph.roadIndex);
  graph.crossingIndex = buildPointIndex(graph.crossingPoints);
  return graph;
};

const SOPOCKA_GRAPH = buildGraph(SOPOCKA_OSM_WAYS);

class MinHeap {
  private readonly values: Array<{ node: number; cost: number }> = [];

  get length(): number {
    return this.values.length;
  }

  push(value: { node: number; cost: number }): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].cost <= this.values[index].cost) break;
      [this.values[parent], this.values[index]] = [this.values[index], this.values[parent]];
      index = parent;
    }
  }

  pop(): { node: number; cost: number } | undefined {
    if (this.values.length === 0) return undefined;
    const first = this.values[0];
    const last = this.values.pop();
    if (last && this.values.length > 0) {
      this.values[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.values.length && this.values[left].cost < this.values[smallest].cost) smallest = left;
        if (right < this.values.length && this.values[right].cost < this.values[smallest].cost) smallest = right;
        if (smallest === index) break;
        [this.values[index], this.values[smallest]] = [this.values[smallest], this.values[index]];
        index = smallest;
      }
    }
    return first;
  }
}

type CellSearchScratch = {
  costs: Float64Array;
  lengths: Float64Array;
  priorities: Float64Array;
  previous: Int32Array;
  stamp: Int32Array;
  generation: number;
};

class CellHeap {
  private nodes = new Int32Array(256);
  private priorities = new Float64Array(256);
  private sizeValue = 0;
  private poppedPriorityValue = Number.POSITIVE_INFINITY;

  get size(): number {
    return this.sizeValue;
  }

  get poppedPriority(): number {
    return this.poppedPriorityValue;
  }

  clear(): void {
    this.sizeValue = 0;
  }

  push(node: number, priority: number): void {
    if (this.sizeValue === this.nodes.length) this.grow();
    let index = this.sizeValue;
    this.nodes[index] = node;
    this.priorities[index] = priority;
    this.sizeValue += 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.priorities[parent] <= this.priorities[index]) break;
      const nodeValue = this.nodes[parent];
      this.nodes[parent] = this.nodes[index];
      this.nodes[index] = nodeValue;
      const priorityValue = this.priorities[parent];
      this.priorities[parent] = this.priorities[index];
      this.priorities[index] = priorityValue;
      index = parent;
    }
  }

  pop(): number {
    if (this.sizeValue === 0) return -1;
    const node = this.nodes[0];
    this.poppedPriorityValue = this.priorities[0];
    this.sizeValue -= 1;
    if (this.sizeValue > 0) {
      this.nodes[0] = this.nodes[this.sizeValue];
      this.priorities[0] = this.priorities[this.sizeValue];
      let index = 0;
      while (true) {
        const left = (index << 1) + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.sizeValue && this.priorities[left] < this.priorities[smallest]) smallest = left;
        if (right < this.sizeValue && this.priorities[right] < this.priorities[smallest]) smallest = right;
        if (smallest === index) break;
        const nodeValue = this.nodes[index];
        this.nodes[index] = this.nodes[smallest];
        this.nodes[smallest] = nodeValue;
        const priorityValue = this.priorities[index];
        this.priorities[index] = this.priorities[smallest];
        this.priorities[smallest] = priorityValue;
        index = smallest;
      }
    }
    return node;
  }

  private grow(): void {
    const nextSize = this.nodes.length * 2;
    const nextNodes = new Int32Array(nextSize);
    const nextPriorities = new Float64Array(nextSize);
    nextNodes.set(this.nodes);
    nextPriorities.set(this.priorities);
    this.nodes = nextNodes;
    this.priorities = nextPriorities;
  }
}

let terrainCellSearchScratch: CellSearchScratch | undefined;
const cellSearchScratch = (cellCount: number): CellSearchScratch => {
  if (!terrainCellSearchScratch || terrainCellSearchScratch.costs.length !== cellCount) {
    terrainCellSearchScratch = {
      costs: new Float64Array(cellCount),
      lengths: new Float64Array(cellCount),
      priorities: new Float64Array(cellCount),
      previous: new Int32Array(cellCount),
      stamp: new Int32Array(cellCount),
      generation: 0,
    };
  }
  terrainCellSearchScratch.generation += 1;
  return terrainCellSearchScratch;
};

const terrainCellHeap = new CellHeap();

/** Nearest graph nodes, searched outward through the spatial index. */
const nearestNodeIds = (
  graph: Graph,
  coordinate: Coordinate,
  predicate: (node: GraphNode) => boolean,
  limit: number,
): number[] => {
  const found: Array<{ nodeId: number; distance: number }> = [];
  for (let ring = 1; ring <= 8 && found.length < limit * 2; ring += 1) {
    found.length = 0;
    const span = ring * SPATIAL_BUCKET_DEGREES;
    for (const key of bucketKeysForBounds(
      coordinate.lat - span,
      coordinate.lat + span,
      coordinate.lng - span,
      coordinate.lng + span,
    )) {
      for (const nodeId of graph.nodeIndex.get(key) ?? []) {
        if (!predicate(graph.nodes[nodeId])) continue;
        found.push({
          nodeId,
          distance: distanceBetweenCoordinates(coordinate, graph.nodes[nodeId].coordinate),
        });
      }
    }
  }
  return found
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map(({ nodeId }) => nodeId);
};

/**
 * Tobler's hiking function, normalised so a flat grade returns 1. Uphill and
 * steep downhill both cost time; a gentle -5% descent is the fastest case.
 */
const TOBLER_FLAT = Math.exp(-3.5 * 0.05);
const gradeSpeedFactor = (grade: number): number =>
  Math.exp(-3.5 * Math.abs(grade + 0.05)) / TOBLER_FLAT;

const speedMetersPerMinute = (
  profile: ActivityProfile,
  grade: number,
  surface: SurfaceClass,
): number => {
  const kmh = FLAT_SPEED_KMH[profile] * gradeSpeedFactor(grade) * SURFACE_SPEED[surface][profile];
  return Math.max(6, (kmh * 1_000) / 60);
};

const maxGradeFor = (input: OSMRoutingRequest): number =>
  Math.max(0.02, input.maxGradePercent / 100);

const terrainFor = (terrain: TerrainModel, coordinate: Coordinate): TerrainCell =>
  terrain.cellAtCoordinate(coordinate);

const segmentProfileScratchFrom: Coordinate = { lat: 0, lng: 0 };
const segmentProfileScratchTo: Coordinate = { lat: 0, lng: 0 };

/**
 * Walk one segment and accumulate real distance, climb, grade, and time.
 *
 * The grid search evaluates this hundreds of thousands of times per request, so
 * it samples through two module-level scratch coordinates rather than
 * allocating one object per sample. That is safe only because the terrain model
 * reads a coordinate's fields and never retains it — and it means this function
 * must never be called reentrantly.
 */
const segmentProfile = (
  from: Coordinate,
  to: Coordinate,
  terrain: TerrainModel,
  profile: ActivityProfile,
  surface: SurfaceClass,
): PathProfile => {
  const count = Math.max(1, Math.ceil(distanceBetweenCoordinates(from, to) / SAMPLE_SPACING_METERS));
  let distanceMeters = 0;
  let elevationChangeMeters = 0;
  let ascentMeters = 0;
  let descentMeters = 0;
  let maxGrade = 0;
  let timeMinutes = 0;
  let waterRisk = 0;
  let sideSlopeDegrees = 0;
  const deltaLat = to.lat - from.lat;
  const deltaLng = to.lng - from.lng;
  const currentSample = segmentProfileScratchFrom;
  const nextSample = segmentProfileScratchTo;
  currentSample.lat = from.lat;
  currentSample.lng = from.lng;
  let previousElevation = terrain.elevationAt(currentSample);

  for (let sample = 1; sample <= count; sample += 1) {
    const fraction = sample / count;
    nextSample.lat = from.lat + deltaLat * fraction;
    nextSample.lng = from.lng + deltaLng * fraction;
    const segmentDistance = distanceBetweenCoordinates(currentSample, nextSample);
    if (segmentDistance < 0.01) continue;
    const toElevation = terrain.elevationAt(nextSample);
    const elevationChange = toElevation - previousElevation;
    const grade = elevationChange / segmentDistance;
    const cell = terrainFor(terrain, nextSample);

    distanceMeters += segmentDistance;
    elevationChangeMeters += elevationChange;
    ascentMeters += Math.max(0, elevationChange);
    descentMeters += Math.max(0, -elevationChange);
    maxGrade = Math.max(maxGrade, Math.abs(grade));
    timeMinutes += segmentDistance / speedMetersPerMinute(profile, grade, surface);
    waterRisk = Math.max(waterRisk, cell.waterRisk);
    sideSlopeDegrees = Math.max(sideSlopeDegrees, cell.slopeDegrees);

    previousElevation = toElevation;
    currentSample.lat = nextSample.lat;
    currentSample.lng = nextSample.lng;
  }

  return {
    distanceMeters,
    elevationChangeMeters,
    ascentMeters,
    descentMeters,
    maxGrade,
    timeMinutes,
    waterRisk,
    sideSlopeDegrees,
  };
};

const nearMappedCrossing = (graph: Graph, point: Coordinate): boolean =>
  crossingCandidatesNear(graph, point)
    .some((crossing) => distanceBetweenCoordinates(point, crossing) <= ROAD_CROSSING_TOLERANCE_METERS);

/**
 * Guard an off-network segment against the street layer, so a connector cannot
 * silently cut across a road or run along a carriageway.
 */
const terrainSegmentAllowed = (
  from: Coordinate,
  to: Coordinate,
  graph: Graph,
  input: OSMRoutingRequest,
): boolean => {
  const length = distanceBetweenCoordinates(from, to);
  const roadCandidates = roadCandidatesForLine(graph, from, to);
  if (!roadCandidates) return true;
  for (const road of roadCandidates) {
    const intersection = segmentIntersection(from, to, road.from, road.to);
    if (!intersection) continue;
    // No "near this segment's own endpoint" exemption here: this same check
    // runs on every single hop of the off-trail grid search, so a blanket
    // endpoint exemption let a multi-hop path slip across an untagged road
    // piecemeal, one short hop at a time, without ever tripping the rule.
    if (!input.allowStreetCrossing && !nearMappedCrossing(graph, intersection)) {
      return false;
    }

    if (!input.allowStreetWalking && !hasWalkwayEvidence(road.feature) && length > 18 &&
        pointDistanceToSegment(from, road.from, road.to) <= 14 &&
        pointDistanceToSegment(to, road.from, road.to) <= 14 &&
        pointDistanceToSegment(interpolateCoordinate(from, to, 0.5), road.from, road.to) <= 14 &&
        segmentsParallel(from, to, road.from, road.to)) {
      return false;
    }
  }
  return true;
};

const profileAllowed = (
  profile: PathProfile,
  input: OSMRoutingRequest,
  bridgeOrTunnel = false,
): boolean => {
  if (profile.maxGrade > maxGradeFor(input) + 0.005) return false;
  if (input.avoidWater && profile.waterRisk > 0.55 && !bridgeOrTunnel) return false;
  return true;
};

const flavorSettings = (input: OSMRoutingRequest, flavor: RouteFlavor) => ({
  // "Direct" tolerates open ground; "Mapped" pays a lot to stay on trails.
  offTrailAversion: flavor === "mapped"
    ? Math.max(input.offTrailAversion, 3.2)
    : flavor === "direct"
      ? 1
      : input.offTrailAversion,
  maxOffTrailMeters: flavor === "direct"
    ? Math.max(input.maxOffTrailMeters, 900)
    : input.maxOffTrailMeters,
});

const connectorStepCost = (
  profile: PathProfile,
  input: OSMRoutingRequest,
  flavor: RouteFlavor,
): number => {
  const { offTrailAversion } = flavorSettings(input, flavor);
  // Traversing a steep side-slope off-trail is slower than the along-path
  // grade alone suggests; this is geometry, not a guess about vegetation.
  const sideSlopePenalty = 1 + clamp(profile.sideSlopeDegrees / 60, 0, 0.6);
  const waterPenalty = 1 + profile.waterRisk * (input.avoidWater ? 8 : 1.5);
  return profile.timeMinutes * offTrailAversion * sideSlopePenalty * waterPenalty;
};

const edgeAllowed = (
  edge: GraphEdge,
  profile: PathProfile,
  input: OSMRoutingRequest,
  graph: Graph,
  from: Coordinate,
  to: Coordinate,
): boolean => {
  if (edge.street && !edge.walkway && !input.allowStreetWalking) return false;
  if (edge.surface === "steps" && input.profile === "mtb") return false;
  if (edge.crossesStreet && !input.allowStreetCrossing &&
      !nearMappedCrossing(graph, from) && !nearMappedCrossing(graph, to)) return false;
  return profileAllowed(profile, input, edge.bridge || edge.tunnel);
};

const edgeCost = (
  from: Coordinate,
  to: Coordinate,
  edge: GraphEdge,
  input: OSMRoutingRequest,
  terrain: TerrainModel,
  graph: Graph,
): number => {
  const profile = segmentProfile(from, to, terrain, input.profile, edge.surface);
  if (!edgeAllowed(edge, profile, input, graph, from, to)) return Number.POSITIVE_INFINITY;
  const waterPenalty = 1 + profile.waterRisk * (input.avoidWater ? 6 : 1.2);
  return Math.max(0.001, profile.timeMinutes * waterPenalty);
};

/**
 * The A* search only steps cell-to-cell (8 directions on a 25 m grid), which
 * staircases any line that isn't aligned to one of those 8 directions. Greedily
 * skip each anchor ahead to the farthest point still reachable by one straight,
 * allowed line — the same crossing/grade/water checks as every other segment,
 * so a shortcut can only straighten the path, never introduce a violation the
 * cell-by-cell search wouldn't have allowed anyway.
 */
const smoothConnectorPath = (
  path: readonly Coordinate[],
  terrain: TerrainModel,
  input: OSMRoutingRequest,
  graph: Graph,
): Coordinate[] => {
  if (path.length <= 2) return [...path];
  const smoothed: Coordinate[] = [path[0]];
  let anchor = 0;
  while (anchor < path.length - 1) {
    let next = anchor + 1;
    for (let candidate = path.length - 1; candidate > anchor + 1; candidate -= 1) {
      if (
        terrainSegmentAllowed(path[anchor], path[candidate], graph, input) &&
        profileAllowed(
          segmentProfile(path[anchor], path[candidate], terrain, input.profile, "open-terrain"),
          input,
        )
      ) {
        next = candidate;
        break;
      }
    }
    smoothed.push(path[next]);
    anchor = next;
  }
  return smoothed;
};

const terrainConnectorPath = (
  from: Coordinate,
  to: Coordinate,
  input: OSMRoutingRequest,
  terrain: TerrainModel,
  graph: Graph,
  flavor: RouteFlavor,
): Coordinate[] | undefined => {
  const budget = flavorSettings(input, flavor).maxOffTrailMeters;
  // A connector can never beat the straight line, so reject early.
  if (distanceBetweenCoordinates(from, to) > budget) return undefined;

  const start = terrainFor(terrain, from);
  const goal = terrainFor(terrain, to);
  const startId = start.row * terrain.columns + start.column;
  const goalId = goal.row * terrain.columns + goal.column;
  if (startId === goalId) {
    const direct = [from, to];
    return terrainSegmentAllowed(from, to, graph, input) &&
      profileAllowed(segmentProfile(from, to, terrain, input.profile, "open-terrain"), input)
      ? direct
      : undefined;
  }

  const cellCount = terrain.rows * terrain.columns;
  const scratch = cellSearchScratch(cellCount);
  const { costs, lengths, priorities, previous, stamp } = scratch;
  const generation = scratch.generation;
  terrainCellHeap.clear();
  costs[startId] = 0;
  lengths[startId] = 0;
  priorities[startId] = 0;
  previous[startId] = -1;
  stamp[startId] = generation;
  terrainCellHeap.push(startId, 0);
  const directions = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1],
  ] as const;
  const fastest = speedMetersPerMinute(input.profile, -0.05, "open-terrain");
  const goalSlack = distanceBetweenCoordinates(to, goal.coordinate);

  while (terrainCellHeap.size > 0) {
    const currentNode = terrainCellHeap.pop();
    if (currentNode < 0) continue;
    if (stamp[currentNode] !== generation || terrainCellHeap.poppedPriority !== priorities[currentNode]) continue;
    if (currentNode === goalId) break;
    const row = Math.floor(currentNode / terrain.columns);
    const column = currentNode % terrain.columns;
    const currentCell = terrain.cellAt(row, column);
    if (!currentCell) continue;

    for (const [rowOffset, columnOffset] of directions) {
      const nextCell = terrain.cellAt(row + rowOffset, column + columnOffset);
      if (!nextCell) continue;
      const nextId = nextCell.row * terrain.columns + nextCell.column;
      if (!terrainSegmentAllowed(currentCell.coordinate, nextCell.coordinate, graph, input)) continue;
      const profile = segmentProfile(
        currentCell.coordinate,
        nextCell.coordinate,
        terrain,
        input.profile,
        "open-terrain",
      );
      if (!profileAllowed(profile, input)) continue;
      const nextLength = lengths[currentNode] + profile.distanceMeters;
      if (nextLength > budget) continue;
      // The rest of the path can never be shorter than the straight line to the
      // goal, so anything already over budget by that measure is unreachable —
      // this prunes the frontier without discarding a cell a valid path could
      // have used. The slack is because the search ends at the goal *cell*
      // while the path ends at `to` somewhere inside it.
      if (nextLength + distanceBetweenCoordinates(nextCell.coordinate, goal.coordinate) >
          budget + goalSlack) continue;
      const nextCost = costs[currentNode] + connectorStepCost(profile, input, flavor);
      if (stamp[nextId] === generation && nextCost >= costs[nextId]) continue;
      costs[nextId] = nextCost;
      lengths[nextId] = nextLength;
      previous[nextId] = currentNode;
      priorities[nextId] = nextCost +
        distanceBetweenCoordinates(nextCell.coordinate, goal.coordinate) / fastest;
      stamp[nextId] = generation;
      terrainCellHeap.push(nextId, priorities[nextId]);
    }
  }

  if (stamp[goalId] !== generation) return undefined;
  const cells: TerrainCell[] = [];
  let cursor = goalId;
  while (cursor >= 0) {
    const cell = terrain.cellAt(Math.floor(cursor / terrain.columns), cursor % terrain.columns);
    if (!cell) return undefined;
    cells.push(cell);
    cursor = previous[cursor];
  }
  cells.reverse();
  const rawPath = [from, ...cells.slice(1, -1).map((cell) => cell.coordinate), to];
  const path = smoothConnectorPath(rawPath, terrain, input, graph);
  let total = 0;
  for (let index = 1; index < path.length; index += 1) {
    if (!terrainSegmentAllowed(path[index - 1], path[index], graph, input)) return undefined;
    const profile = segmentProfile(
      path[index - 1],
      path[index],
      terrain,
      input.profile,
      "open-terrain",
    );
    if (!profileAllowed(profile, input)) return undefined;
    total += profile.distanceMeters;
  }
  return total <= budget ? path : undefined;
};

class ConnectorCache {
  private readonly values = new Map<string, Coordinate[] | null>();

  get(
    from: Coordinate,
    to: Coordinate,
    input: OSMRoutingRequest,
    terrain: TerrainModel,
    graph: Graph,
    flavor: RouteFlavor,
  ): Coordinate[] | undefined {
    const key = `${flavor}|${coordinateKey(from)}>${coordinateKey(to)}`;
    if (this.values.has(key)) return this.values.get(key) ?? undefined;
    const path = terrainConnectorPath(from, to, input, terrain, graph, flavor);
    this.values.set(key, path ?? null);
    return path;
  }
}

const connectorCost = (
  path: readonly Coordinate[],
  input: OSMRoutingRequest,
  terrain: TerrainModel,
  flavor: RouteFlavor,
): number => {
  let cost = 0;
  for (let index = 1; index < path.length; index += 1) {
    cost += connectorStepCost(
      segmentProfile(path[index - 1], path[index], terrain, input.profile, "open-terrain"),
      input,
      flavor,
    );
  }
  return cost;
};

const searchNetwork = (
  graph: Graph,
  origin: Coordinate,
  destination: Coordinate | undefined,
  input: OSMRoutingRequest,
  terrain: TerrainModel,
  flavor: RouteFlavor,
  connectors: ConnectorCache,
): { path: SearchPath; endCoordinate: Coordinate } | undefined => {
  const reachable = (node: GraphNode) => input.allowStreetWalking || node.pathEvidence;
  const startIds = nearestNodeIds(graph, origin, reachable, MAX_CONNECTOR_NODES);
  const goalIds = destination
    ? nearestNodeIds(graph, destination, reachable, MAX_CONNECTOR_NODES)
    : nearestNodeIds(graph, origin, (node) => node.pathEvidence, MAX_NEAREST_PATH_NODES);
  if (startIds.length === 0 || goalIds.length === 0) return undefined;

  const goalSet = new Set(goalIds);
  const costs = new Float64Array(graph.nodes.length).fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(graph.nodes.length).fill(-1);
  const previousEdges: Array<GraphEdge | undefined> = Array.from({ length: graph.nodes.length });
  const startConnectorPaths = new Map<number, Coordinate[]>();
  const heap = new MinHeap();

  for (const nodeId of startIds) {
    const node = graph.nodes[nodeId];
    const connector = connectors.get(origin, node.coordinate, input, terrain, graph, flavor);
    if (!connector) continue;
    const initialCost = connectorCost(connector, input, terrain, flavor);
    if (initialCost < costs[nodeId]) {
      costs[nodeId] = initialCost;
      startConnectorPaths.set(nodeId, connector);
      heap.push({ node: nodeId, cost: initialCost });
    }
  }

  let goalNode = -1;
  let bestCost = Number.POSITIVE_INFINITY;
  let bestEndConnector: Coordinate[] | undefined;
  while (heap.length > 0) {
    const current = heap.pop();
    if (!current || current.cost !== costs[current.node]) continue;
    if (current.cost > bestCost) break;
    const currentNode = graph.nodes[current.node];
    if (goalSet.has(current.node)) {
      const finalConnector = destination
        ? connectors.get(currentNode.coordinate, destination, input, terrain, graph, flavor)
        : [currentNode.coordinate];
      if (finalConnector) {
        const finalCost = current.cost + connectorCost(finalConnector, input, terrain, flavor);
        if (finalCost < bestCost) {
          bestCost = finalCost;
          goalNode = current.node;
          bestEndConnector = finalConnector;
        }
      }
    }

    for (const edge of currentNode.edges) {
      const nextCost = current.cost +
        edgeCost(currentNode.coordinate, graph.nodes[edge.to].coordinate, edge, input, terrain, graph);
      if (!Number.isFinite(nextCost) || nextCost >= costs[edge.to]) continue;
      costs[edge.to] = nextCost;
      previous[edge.to] = current.node;
      previousEdges[edge.to] = edge;
      heap.push({ node: edge.to, cost: nextCost });
    }
  }

  if (goalNode < 0 || !bestEndConnector) return undefined;
  const nodeIds: number[] = [];
  const edges: GraphEdge[] = [];
  let cursor = goalNode;
  while (cursor >= 0) {
    nodeIds.push(cursor);
    const edge = previousEdges[cursor];
    if (edge) edges.push(edge);
    cursor = previous[cursor];
  }
  nodeIds.reverse();
  edges.reverse();
  const startConnector = startConnectorPaths.get(nodeIds[0]);
  if (!startConnector) return undefined;
  return {
    path: { nodeIds, edges, startConnector, endConnector: bestEndConnector },
    endCoordinate: graph.nodes[goalNode].coordinate,
  };
};

const appendPolyline = (
  segments: OSMRouteSegment[],
  path: readonly Coordinate[],
  terrain: TerrainModel,
  input: OSMRoutingRequest,
  mappedPath: boolean,
  surface: SurfaceClass,
  highway?: string,
  wayName?: string,
): void => {
  for (let index = 1; index < path.length; index += 1) {
    const from = path[index - 1];
    const to = path[index];
    if (distanceBetweenCoordinates(from, to) < 0.5) continue;
    const profile = segmentProfile(from, to, terrain, input.profile, surface);
    segments.push({
      from,
      to,
      distanceMeters: profile.distanceMeters,
      elevationChangeMeters: profile.elevationChangeMeters,
      grade: profile.elevationChangeMeters / Math.max(profile.distanceMeters, 1),
      estimatedTimeMinutes: profile.timeMinutes,
      waterRisk: profile.waterRisk,
      mappedPath,
      highway,
      surfaceLabel: surface,
      wayName,
    });
  }
};

const appendLeg = (
  segments: OSMRouteSegment[],
  destination: Coordinate | undefined,
  search: { path: SearchPath; endCoordinate: Coordinate },
  graph: Graph,
  terrain: TerrainModel,
  input: OSMRoutingRequest,
): Coordinate => {
  appendPolyline(segments, search.path.startConnector, terrain, input, false, "open-terrain");
  for (let index = 1; index < search.path.nodeIds.length; index += 1) {
    const from = graph.nodes[search.path.nodeIds[index - 1]];
    const to = graph.nodes[search.path.nodeIds[index]];
    const edge = search.path.edges[index - 1];
    appendPolyline(
      segments,
      [from.coordinate, to.coordinate],
      terrain,
      input,
      edge?.mappedPath ?? false,
      edge?.surface ?? "open-terrain",
      edge?.highway,
      edge?.name,
    );
  }
  if (destination) {
    appendPolyline(
      segments,
      search.path.endConnector ?? [search.endCoordinate, destination],
      terrain,
      input,
      false,
      "open-terrain",
    );
    return destination;
  }
  return search.endCoordinate;
};

/** Cheap identity for a route, so two objectives that agree are offered once. */
const routeSignature = (route: OSMRoute): string => [
  Math.round(route.distanceMeters),
  route.coordinates.length,
  ...route.coordinates
    .filter((_, index) => index % Math.max(1, Math.floor(route.coordinates.length / 12)) === 0)
    .map(coordinateKey),
].join("|");

const OBJECTIVE_LABELS: Record<RouteFlavor, string> = {
  balanced: "Balanced",
  direct: "Most direct",
  mapped: "Stay on trails",
};

const buildRoute = (
  input: OSMRoutingRequest,
  terrain: TerrainModel,
  flavor: RouteFlavor,
  index: number,
  connectors: ConnectorCache,
): OSMRoute | undefined => {
  const segments: OSMRouteSegment[] = [];
  let current = input.origin;
  let snappedDestination: Coordinate | undefined;

  if (input.mode === "nearest") {
    const search = searchNetwork(SOPOCKA_GRAPH, current, undefined, input, terrain, flavor, connectors);
    if (!search) return undefined;
    current = appendLeg(segments, undefined, search, SOPOCKA_GRAPH, terrain, input);
    snappedDestination = current;
  } else {
    const targets = input.mode === "design"
      ? [...input.waypoints, ...(input.destination ? [input.destination] : [])]
      : input.destination ? [input.destination] : [];
    for (const target of targets) {
      const search = searchNetwork(SOPOCKA_GRAPH, current, target, input, terrain, flavor, connectors);
      if (!search) return undefined;
      current = appendLeg(segments, target, search, SOPOCKA_GRAPH, terrain, input);
      snappedDestination = search.endCoordinate;
    }
  }

  if (segments.length === 0) return undefined;

  let distanceMeters = 0;
  let ascentMeters = 0;
  let descentMeters = 0;
  let maxGrade = 0;
  let estimatedTimeMinutes = 0;
  let mappedDistanceMeters = 0;
  let waterDistanceMeters = 0;
  let offTrailRun = 0;
  let longestOffTrailMeters = 0;
  const surfaceTotals = new Map<SurfaceClass, number>();
  const wayNames: string[] = [];
  const samples: ElevationSample[] = [];

  for (const segment of segments) {
    distanceMeters += segment.distanceMeters;
    ascentMeters += Math.max(0, segment.elevationChangeMeters);
    descentMeters += Math.max(0, -segment.elevationChangeMeters);
    maxGrade = Math.max(maxGrade, Math.abs(segment.grade));
    estimatedTimeMinutes += segment.estimatedTimeMinutes;
    if (segment.mappedPath) {
      mappedDistanceMeters += segment.distanceMeters;
      offTrailRun = 0;
    } else {
      offTrailRun += segment.distanceMeters;
      longestOffTrailMeters = Math.max(longestOffTrailMeters, offTrailRun);
    }
    if (segment.waterRisk > 0.4) waterDistanceMeters += segment.distanceMeters;
    surfaceTotals.set(
      segment.surfaceLabel,
      (surfaceTotals.get(segment.surfaceLabel) ?? 0) + segment.distanceMeters,
    );
    if (segment.wayName && wayNames[wayNames.length - 1] !== segment.wayName) {
      if (!wayNames.includes(segment.wayName)) wayNames.push(segment.wayName);
    }
    samples.push({
      distanceMeters,
      elevationMeters: terrain.elevationAt(segment.to),
      grade: segment.grade,
      mappedPath: segment.mappedPath,
    });
  }

  samples.unshift({
    distanceMeters: 0,
    elevationMeters: terrain.elevationAt(segments[0].from),
    grade: segments[0].grade,
    mappedPath: segments[0].mappedPath,
  });

  const offTrailDistanceMeters = Math.max(0, distanceMeters - mappedDistanceMeters);
  const mappedShare = mappedDistanceMeters / Math.max(distanceMeters, 1);
  const confidence = clamp(
    0.55 + mappedShare * 0.4 -
      (waterDistanceMeters / Math.max(distanceMeters, 1)) * 0.2 +
      (terrain.hasElevation ? 0.05 : -0.15),
    0.3,
    0.96,
  );

  return {
    id: `osm-${flavor}-${index + 1}`,
    objective: flavor,
    objectiveLabel: OBJECTIVE_LABELS[flavor],
    coordinates: [segments[0].from, ...segments.map((segment) => segment.to)],
    segments,
    samples,
    distanceMeters,
    ascentMeters,
    descentMeters,
    maxGrade,
    estimatedTimeMinutes,
    mappedDistanceMeters,
    offTrailDistanceMeters,
    longestOffTrailMeters,
    waterDistanceMeters,
    surfaceBreakdown: [...surfaceTotals.entries()]
      .map(([surface, meters]) => ({ surface, distanceMeters: meters }))
      .sort((a, b) => b.distanceMeters - a.distanceMeters),
    wayNames,
    confidence,
    snappedDestination,
  };
};

export const planOSMRoute = (
  input: OSMRoutingRequest,
  terrain: TerrainModel,
): OSMRoutingResult => {
  const flavors: RouteFlavor[] = input.mode === "nearest"
    ? ["balanced"]
    : input.alternatives > 1
      ? ["balanced", "direct", "mapped"]
      : ["balanced"];
  const routes: OSMRoute[] = [];
  const signatures = new Set<string>();
  const connectors = new ConnectorCache();

  // Each flavour optimises a different objective, so the options offered are
  // honestly labelled. Identical geometry is dropped rather than relabelled.
  for (const [index, flavor] of flavors.entries()) {
    const route = buildRoute(input, terrain, flavor, index, connectors);
    if (!route) continue;
    const signature = routeSignature(route);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    routes.push(route);
  }

  const warnings: string[] = [];
  if (routes.length > 0 && !terrain.hasElevation) {
    warnings.push("Elevation data is unavailable, so climb and time figures assume flat ground.");
  }

  return {
    routes,
    warnings,
    errors: routes.length > 0
      ? []
      : ["No route satisfies the current grade, off-trail, water, and street-access limits."],
  };
};

export const osmGraphStats = {
  nodes: SOPOCKA_GRAPH.nodes.length,
  directedEdges: SOPOCKA_GRAPH.nodes.reduce((total, node) => total + node.edges.length, 0),
  mappedCrossings: SOPOCKA_GRAPH.crossingPoints.length,
};
