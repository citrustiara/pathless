import {
  type Coordinate,
  type GeoBounds,
  type LandCover,
  type MappedPathKind,
  SYNTHETIC_TERRAIN_CENTER,
  type SyntheticTerrainOptions,
  type TerrainCell,
  type TerrainModel,
} from "./types";

const METERS_PER_DEGREE_LATITUDE = 111_132;
const DEFAULT_ROWS = 73;
const DEFAULT_COLUMNS = 73;
const DEFAULT_CELL_SIZE_METERS = 50;
const DEFAULT_ID = "synthetic-gdynia-west-01";
const DEFAULT_NAME = "Synthetic terrain near 54.458403, 18.509192";

const TERRAIN_ASSUMPTIONS = [
  "A 50 m local grid approximates the terrain around the supplied centre point.",
  "Elevation is a deterministic blend of hills, a shallow valley, and local undulation.",
  "Mapped trails are synthetic corridors used as positive evidence, not live map data.",
  "Water is represented as a soft risk surface so the router can cross it only when necessary.",
  "All confidence scores describe prototype evidence quality and are not survey-grade claims.",
] as const;

type LocalPoint = { x: number; y: number };
type RawCell = Omit<TerrainCell, "slopeDegrees"> & { slopeDegrees: number };

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const squared = (value: number): number => value * value;

const gaussian = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
): number =>
  Math.exp(
    -0.5 *
      (squared((x - centerX) / radiusX) + squared((y - centerY) / radiusY)),
  );

const distanceBetweenLocalPoints = (a: LocalPoint, b: LocalPoint): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const distanceToSegment = (
  point: LocalPoint,
  start: LocalPoint,
  end: LocalPoint,
): number => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return distanceBetweenLocalPoints(point, start);
  }

  const projection = clamp(
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    0,
    1,
  );

  return distanceBetweenLocalPoints(point, {
    x: start.x + projection * dx,
    y: start.y + projection * dy,
  });
};

const distanceToPolyline = (
  point: LocalPoint,
  polyline: readonly LocalPoint[],
): number => {
  let minimum = Number.POSITIVE_INFINITY;

  for (let index = 1; index < polyline.length; index += 1) {
    minimum = Math.min(
      minimum,
      distanceToSegment(point, polyline[index - 1], polyline[index]),
    );
  }

  return minimum;
};

const MAIN_TRAIL: readonly LocalPoint[] = [
  { x: -1_650, y: -980 },
  { x: -1_050, y: -610 },
  { x: -360, y: -260 },
  { x: 300, y: 80 },
  { x: 980, y: 440 },
  { x: 1_650, y: 770 },
];

const RIDGE_TRAIL: readonly LocalPoint[] = [
  { x: -1_550, y: 760 },
  { x: -920, y: 580 },
  { x: -250, y: 510 },
  { x: 430, y: 650 },
  { x: 1_550, y: 480 },
];

const MEADOW_TRAIL: readonly LocalPoint[] = [
  { x: -1_400, y: 50 },
  { x: -920, y: -100 },
  { x: -360, y: 10 },
  { x: 220, y: -80 },
  { x: 760, y: -20 },
  { x: 1_400, y: 160 },
];

const localToCoordinate = (
  point: LocalPoint,
  center: Coordinate,
  metersPerDegreeLongitude: number,
): Coordinate => ({
  lat: center.lat + point.y / METERS_PER_DEGREE_LATITUDE,
  lng: center.lng + point.x / metersPerDegreeLongitude,
});

const coordinateToLocal = (
  coordinate: Coordinate,
  center: Coordinate,
  metersPerDegreeLongitude: number,
): LocalPoint => ({
  x: (coordinate.lng - center.lng) * metersPerDegreeLongitude,
  y: (coordinate.lat - center.lat) * METERS_PER_DEGREE_LATITUDE,
});

/** Convert a WGS84 pair to local metres around the default synthetic centre. */
export const coordinateToLocalMeters = (coordinate: Coordinate): LocalPoint =>
  coordinateToLocal(
    coordinate,
    SYNTHETIC_TERRAIN_CENTER,
    METERS_PER_DEGREE_LATITUDE *
      Math.cos(toRadians(SYNTHETIC_TERRAIN_CENTER.lat)),
  );

/** Convert local metres around the default synthetic centre to WGS84. */
export const localMetersToCoordinate = (point: LocalPoint): Coordinate =>
  localToCoordinate(
    point,
    SYNTHETIC_TERRAIN_CENTER,
    METERS_PER_DEGREE_LATITUDE *
      Math.cos(toRadians(SYNTHETIC_TERRAIN_CENTER.lat)),
  );

/**
 * Approximate local geodesic distance.  The map is small enough that an
 * equirectangular projection is more stable and cheaper than spherical math.
 */
export const distanceBetweenCoordinates = (
  a: Coordinate,
  b: Coordinate,
): number => {
  const latitude = toRadians((a.lat + b.lat) / 2);
  const metersPerDegreeLongitude =
    METERS_PER_DEGREE_LATITUDE * Math.cos(latitude);
  return Math.hypot(
    (b.lng - a.lng) * metersPerDegreeLongitude,
    (b.lat - a.lat) * METERS_PER_DEGREE_LATITUDE,
  );
};

const normalizedDimensions = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(9, Math.floor(value as number));
};

/**
 * Deterministic terrain provider used by the prototype.  It intentionally has
 * no network or GIS dependency: the same centre and dimensions always produce
 * the same elevation, surface, water-risk, and mapped-trail evidence.
 */
export class SyntheticTerrainModel implements TerrainModel {
  readonly id: string;
  readonly name: string;
  readonly dataSource = "synthetic-local" as const;
  readonly center: Coordinate;
  readonly bounds: GeoBounds;
  readonly rows: number;
  readonly columns: number;
  readonly cellSizeMeters: number;
  readonly assumptions = TERRAIN_ASSUMPTIONS;
  readonly cells: readonly TerrainCell[];

  private readonly cellsByIndex: readonly RawCell[];
  private readonly centreRow: number;
  private readonly centreColumn: number;
  private readonly metersPerDegreeLongitude: number;
  private readonly halfWidthMeters: number;
  private readonly halfHeightMeters: number;

  constructor(options: SyntheticTerrainOptions = {}) {
    this.center = {
      lat: options.center?.lat ?? SYNTHETIC_TERRAIN_CENTER.lat,
      lng: options.center?.lng ?? SYNTHETIC_TERRAIN_CENTER.lng,
    };
    this.rows = normalizedDimensions(options.rows, DEFAULT_ROWS);
    this.columns = normalizedDimensions(options.columns, DEFAULT_COLUMNS);
    this.cellSizeMeters = Number.isFinite(options.cellSizeMeters)
      ? Math.max(10, options.cellSizeMeters as number)
      : DEFAULT_CELL_SIZE_METERS;
    this.id = options.id ?? DEFAULT_ID;
    this.name = options.name ?? DEFAULT_NAME;
    this.centreRow = Math.floor((this.rows - 1) / 2);
    this.centreColumn = Math.floor((this.columns - 1) / 2);
    this.metersPerDegreeLongitude =
      METERS_PER_DEGREE_LATITUDE * Math.cos(toRadians(this.center.lat));
    this.halfWidthMeters = Math.max(
      this.centreColumn,
      this.columns - 1 - this.centreColumn,
    ) * this.cellSizeMeters;
    this.halfHeightMeters = Math.max(
      this.centreRow,
      this.rows - 1 - this.centreRow,
    ) * this.cellSizeMeters;
    this.bounds = this.buildBounds();

    const rawCells: RawCell[] = [];
    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const local = this.localPointFor(row, column);
        const surface = this.surfaceFor(local);
        rawCells.push({
          row,
          column,
          coordinate: localToCoordinate(
            local,
            this.center,
            this.metersPerDegreeLongitude,
          ),
          xMeters: local.x,
          yMeters: local.y,
          elevationMeters: surface.elevationMeters,
          slopeDegrees: 0,
          roughness: surface.roughness,
          landCover: surface.landCover,
          waterRisk: surface.waterRisk,
          mappedPath: surface.mappedPath,
          mappedPathKind: surface.mappedPathKind,
        });
      }
    }

    for (const cell of rawCells) {
      const neighbouringElevations = this.cardinalNeighbours(cell, rawCells).map(
        (neighbour) =>
          (Math.abs(cell.elevationMeters - neighbour.elevationMeters) /
            this.cellSizeMeters),
      );
      cell.slopeDegrees =
        neighbouringElevations.length > 0
          ? (Math.atan(Math.max(...neighbouringElevations)) * 180) / Math.PI
          : 0;
    }

    this.cellsByIndex = rawCells;
    this.cells = rawCells;
  }

  cellAt(row: number, column: number): TerrainCell | undefined {
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      row >= this.rows ||
      column < 0 ||
      column >= this.columns
    ) {
      return undefined;
    }

    return this.cellsByIndex[this.indexFor(row, column)];
  }

  cellAtCoordinate(coordinate: Coordinate): TerrainCell {
    const local = coordinateToLocal(
      coordinate,
      this.center,
      this.metersPerDegreeLongitude,
    );
    const column = clamp(
      Math.round(local.x / this.cellSizeMeters) + this.centreColumn,
      0,
      this.columns - 1,
    );
    const row = clamp(
      this.centreRow - Math.round(local.y / this.cellSizeMeters),
      0,
      this.rows - 1,
    );

    return this.cellsByIndex[this.indexFor(row, column)];
  }

  nearestCell(
    coordinate: Coordinate,
    predicate?: (cell: TerrainCell) => boolean,
  ): TerrainCell {
    const local = coordinateToLocal(
      coordinate,
      this.center,
      this.metersPerDegreeLongitude,
    );
    let nearest: RawCell | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const cell of this.cellsByIndex) {
      if (predicate && !predicate(cell) && nearest !== undefined) {
        continue;
      }

      if (predicate && !predicate(cell)) {
        continue;
      }

      const distance = squared(cell.xMeters - local.x) + squared(cell.yMeters - local.y);
      if (distance < nearestDistance) {
        nearest = cell;
        nearestDistance = distance;
      }
    }

    return nearest ?? this.cellsByIndex[0];
  }

  contains(coordinate: Coordinate): boolean {
    const local = coordinateToLocal(
      coordinate,
      this.center,
      this.metersPerDegreeLongitude,
    );
    return (
      Math.abs(local.x) <= this.halfWidthMeters &&
      Math.abs(local.y) <= this.halfHeightMeters
    );
  }

  /** Returns zero inside the grid and the shortest distance back to its edge outside it. */
  distanceToBoundaryMeters(coordinate: Coordinate): number {
    const local = coordinateToLocal(
      coordinate,
      this.center,
      this.metersPerDegreeLongitude,
    );
    const outsideX = Math.max(0, Math.abs(local.x) - this.halfWidthMeters);
    const outsideY = Math.max(0, Math.abs(local.y) - this.halfHeightMeters);
    return Math.hypot(outsideX, outsideY);
  }

  private indexFor(row: number, column: number): number {
    return row * this.columns + column;
  }

  private localPointFor(row: number, column: number): LocalPoint {
    return {
      x: (column - this.centreColumn) * this.cellSizeMeters,
      y: (this.centreRow - row) * this.cellSizeMeters,
    };
  }

  private buildBounds(): GeoBounds {
    const northWest = localToCoordinate(
      { x: -this.halfWidthMeters, y: this.halfHeightMeters },
      this.center,
      this.metersPerDegreeLongitude,
    );
    const southEast = localToCoordinate(
      { x: this.halfWidthMeters, y: -this.halfHeightMeters },
      this.center,
      this.metersPerDegreeLongitude,
    );

    return {
      north: northWest.lat,
      south: southEast.lat,
      east: southEast.lng,
      west: northWest.lng,
    };
  }

  private cardinalNeighbours(cell: RawCell, cells: readonly RawCell[]): RawCell[] {
    const neighbours: RawCell[] = [];
    const candidates = [
      [cell.row - 1, cell.column],
      [cell.row + 1, cell.column],
      [cell.row, cell.column - 1],
      [cell.row, cell.column + 1],
    ] as const;

    for (const [row, column] of candidates) {
      if (row >= 0 && row < this.rows && column >= 0 && column < this.columns) {
        neighbours.push(cells[this.indexFor(row, column)]);
      }
    }

    return neighbours;
  }

  private surfaceFor(local: LocalPoint): {
    elevationMeters: number;
    roughness: number;
    landCover: LandCover;
    waterRisk: number;
    mappedPath: boolean;
    mappedPathKind: MappedPathKind;
  } {
    // The terms are intentionally smooth so adjacent cells produce sensible
    // grades, while the higher-frequency term gives the roughness slider
    // something tangible to optimize around.
    const ridgeLine = 0.28 * local.x + 380;
    const elevationMeters =
      46 +
      24 * gaussian(local.x, local.y, 480, 560, 520, 440) +
      17 * gaussian(local.x, local.y, -720, 240, 430, 620) -
      19 * gaussian(local.x, local.y, 120, -510, 600, 300) +
      10 * Math.exp(-squared((local.y - ridgeLine) / 210)) +
      3.8 * Math.sin(local.x / 180) * Math.cos(local.y / 245) +
      2.2 * Math.sin((local.x + local.y) / 75);

    const riverCentre =
      0.22 * local.x - 210 + 105 * Math.sin((local.x + 180) / 310);
    const riverGate = clamp(1 - Math.abs(local.x) / 1_850, 0, 1);
    const riverDistance = Math.abs(local.y - riverCentre);
    const streamRisk = riverGate * clamp(1 - riverDistance / 58, 0, 1);

    const pondRisk = Math.max(
      gaussian(local.x, local.y, 720, -180, 145, 100),
      gaussian(local.x, local.y, -930, -330, 120, 85),
    );
    const wetlandRisk = Math.max(
      0,
      clamp(1 - riverDistance / 175, 0, 1) * riverGate,
      gaussian(local.x, local.y, 280, -290, 260, 170) * 0.75,
    );
    const waterRisk = clamp(Math.max(streamRisk, pondRisk, wetlandRisk * 0.72), 0, 1);

    const forestSignal =
      0.5 +
      0.22 * Math.sin((local.x + 360) / 260) +
      0.18 * Math.cos((local.y - 120) / 310) +
      0.16 * gaussian(local.x, local.y, -620, 540, 720, 560) +
      0.1 * gaussian(local.x, local.y, 700, 620, 500, 350);

    const landCover: LandCover =
      waterRisk > 0.82
        ? "water"
        : waterRisk > 0.44
          ? "wetland"
          : forestSignal > 0.58
            ? "forest"
            : "meadow";

    const roughness = clamp(
      0.1 +
        0.1 * Math.abs(Math.sin(local.x / 115)) +
        0.1 * Math.abs(Math.cos(local.y / 145)) +
        (landCover === "forest" ? 0.2 : 0) +
        (landCover === "wetland" ? 0.22 : 0) +
        clamp(Math.abs(elevationMeters - 50) / 75, 0, 0.22) +
        waterRisk * 0.14,
      0.04,
      0.95,
    );

    const trailDistances = [
      { kind: "meadow-track" as const, distance: distanceToPolyline(local, MEADOW_TRAIL) },
      { kind: "ridge-trail" as const, distance: distanceToPolyline(local, RIDGE_TRAIL) },
      { kind: "forest-trail" as const, distance: distanceToPolyline(local, MAIN_TRAIL) },
      {
        kind: "forest-trail" as const,
        distance: Math.abs(Math.hypot(local.x + 260, local.y - 80) - 610),
      },
    ].sort((a, b) => a.distance - b.distance);

    const nearestTrail = trailDistances[0];
    const mappedPath = nearestTrail.distance <= this.cellSizeMeters * 0.62;

    return {
      elevationMeters,
      roughness: mappedPath ? clamp(roughness - 0.12, 0.03, 0.95) : roughness,
      landCover,
      waterRisk,
      mappedPath,
      mappedPathKind: mappedPath ? nearestTrail.kind : "none",
    };
  }
}

export const createSyntheticTerrainModel = (
  options: SyntheticTerrainOptions = {},
): SyntheticTerrainModel => new SyntheticTerrainModel(options);

/** Short alias for consumers that do not need the longer descriptive name. */
export const createSyntheticTerrain = createSyntheticTerrainModel;

