/**
 * The routing terrain model.
 *
 * This is a coarse regular grid laid over the working area, filled from a real
 * elevation grid plus the mapped watercourses from OSM. Nothing in here is
 * invented: if the elevation source is unavailable the model reports
 * `hasElevation: false` and stays flat, and the UI is expected to say so.
 *
 * Building the grid means walking every native elevation sample at least
 * once, which for the current survey area is a few million iterations of
 * plain arithmetic — a few hundred milliseconds of uninterruptible work.
 * Done inside a React render that blocks the tab, which is bad enough on a
 * fast machine and worse on a slow one. `buildTerrainGridArrays` is written
 * as a standalone, dependency-free function for exactly that reason: it is
 * the part `terrain.worker.ts` runs off the main thread, and this file's own
 * synchronous constructor is just the same function called inline, kept for
 * tests and for the flat "no elevation" model, which is cheap either way.
 */
import {
  clamp,
  distanceBetweenCoordinates,
  METERS_PER_DEGREE_LATITUDE,
  metersPerDegreeLongitude,
} from "./geo";
import type { ElevationGrid, RawElevationSource } from "./elevation";
import { createFlatElevationGrid, sampleElevationData } from "./elevation";
import type { Coordinate, GeoBounds, TerrainCell, TerrainDataSource, TerrainModel } from "./types";

/** How far the influence of a mapped watercourse reaches, in metres. */
const WATER_INFLUENCE_METERS = 26;
const DEFAULT_CELL_SIZE_METERS = 25;

export type TerrainModelOptions = {
  readonly bounds: GeoBounds;
  readonly elevation?: ElevationGrid;
  readonly cellSizeMeters?: number;
  /** Mapped watercourse polylines, used as the only water evidence. */
  readonly waterways?: ReadonlyArray<ReadonlyArray<Coordinate>>;
  readonly id?: string;
  readonly name?: string;
};

export type TerrainGridGeometry = {
  readonly bounds: GeoBounds;
  readonly center: Coordinate;
  readonly rows: number;
  readonly columns: number;
  readonly cellSizeMeters: number;
  readonly latitudeStep: number;
  readonly longitudeStep: number;
};

/** Pure function of `bounds` and `cellSizeMeters`, so a worker can reproduce it without needing anything else from the main thread. */
export const terrainGridGeometry = (
  bounds: GeoBounds,
  cellSizeMeters = DEFAULT_CELL_SIZE_METERS,
): TerrainGridGeometry => {
  const clampedCellSize = Math.max(5, cellSizeMeters);
  const center = { lat: (bounds.north + bounds.south) / 2, lng: (bounds.east + bounds.west) / 2 };
  const heightMeters = (bounds.north - bounds.south) * METERS_PER_DEGREE_LATITUDE;
  const widthMeters = (bounds.east - bounds.west) * metersPerDegreeLongitude(center.lat);
  const rows = Math.max(3, Math.round(heightMeters / clampedCellSize) + 1);
  const columns = Math.max(3, Math.round(widthMeters / clampedCellSize) + 1);
  return {
    bounds,
    center,
    rows,
    columns,
    cellSizeMeters: clampedCellSize,
    latitudeStep: (bounds.north - bounds.south) / (rows - 1),
    longitudeStep: (bounds.east - bounds.west) / (columns - 1),
  };
};

const coordinateAt = (geometry: TerrainGridGeometry, row: number, column: number): Coordinate => ({
  lat: geometry.bounds.north - row * geometry.latitudeStep,
  lng: geometry.bounds.west + column * geometry.longitudeStep,
});

/**
 * Stamp a decaying disc around every mapped watercourse. Walking the lines is
 * far cheaper than testing each cell against every segment.
 */
const rasterizeWater = (
  geometry: TerrainGridGeometry,
  waterways: ReadonlyArray<ReadonlyArray<Coordinate>>,
): Float32Array => {
  const { rows, columns, bounds, latitudeStep, longitudeStep, cellSizeMeters } = geometry;
  const risk = new Float32Array(rows * columns);
  const radiusInCells = Math.ceil(WATER_INFLUENCE_METERS / cellSizeMeters);
  const step = Math.max(4, cellSizeMeters / 2);

  const stamp = (point: Coordinate): void => {
    const centreRow = Math.round((bounds.north - point.lat) / latitudeStep);
    const centreColumn = Math.round((point.lng - bounds.west) / longitudeStep);
    for (let row = centreRow - radiusInCells; row <= centreRow + radiusInCells; row += 1) {
      if (row < 0 || row >= rows) continue;
      for (let column = centreColumn - radiusInCells; column <= centreColumn + radiusInCells; column += 1) {
        if (column < 0 || column >= columns) continue;
        const distance = distanceBetweenCoordinates(point, coordinateAt(geometry, row, column));
        const value = clamp(1 - distance / WATER_INFLUENCE_METERS, 0, 1);
        const index = row * columns + column;
        if (value > risk[index]) risk[index] = value;
      }
    }
  };

  for (const line of waterways) {
    for (let index = 1; index < line.length; index += 1) {
      const from = line[index - 1];
      const to = line[index];
      const length = distanceBetweenCoordinates(from, to);
      const steps = Math.max(1, Math.ceil(length / step));
      for (let sample = 0; sample <= steps; sample += 1) {
        const fraction = sample / steps;
        stamp({
          lat: from.lat + (to.lat - from.lat) * fraction,
          lng: from.lng + (to.lng - from.lng) * fraction,
        });
      }
    }
  }

  return risk;
};

/**
 * Slope per routing cell, measured at the elevation source's own resolution.
 *
 * Fitting a gradient across the routing step would report whatever a 5 m or
 * 25 m stride happens to average, which is not the ground a walker meets: a
 * cell holding a short bank reads as gentle. So Horn's 3x3 gradient runs over
 * the native grid instead, and each routing cell keeps both the mean of the
 * native slopes inside it and the steepest one — the pair that separates a
 * walkable shelf from a shelf with a scarp across it.
 */
const buildSlopeFields = (
  geometry: TerrainGridGeometry,
  source: RawElevationSource | undefined,
  elevations: Float32Array,
): { meanSlopeDegrees: Float32Array; maxSlopeDegrees: Float32Array } => {
  const { rows, columns, bounds, center, latitudeStep, longitudeStep } = geometry;
  const cellCount = rows * columns;
  const meanSlopeDegrees = new Float32Array(cellCount);
  const maxSlopeDegrees = new Float32Array(cellCount);
  const routingNorthSouthMeters = latitudeStep * METERS_PER_DEGREE_LATITUDE;
  const routingEastWestMeters = longitudeStep * metersPerDegreeLongitude(center.lat);
  const routingAt = (row: number, column: number): number =>
    elevations[clamp(row, 0, rows - 1) * columns + clamp(column, 0, columns - 1)];
  const routingFallback = (row: number, column: number): number => {
    const dzdx = (
      (routingAt(row - 1, column + 1) + 2 * routingAt(row, column + 1) + routingAt(row + 1, column + 1)) -
      (routingAt(row - 1, column - 1) + 2 * routingAt(row, column - 1) + routingAt(row + 1, column - 1))
    ) / (8 * routingEastWestMeters);
    const dzdy = (
      (routingAt(row + 1, column - 1) + 2 * routingAt(row + 1, column) + routingAt(row + 1, column + 1)) -
      (routingAt(row - 1, column - 1) + 2 * routingAt(row - 1, column) + routingAt(row - 1, column + 1))
    ) / (8 * routingNorthSouthMeters);
    return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
  };

  if (!source) {
    for (let index = 0; index < cellCount; index += 1) {
      const fallback = routingFallback(Math.floor(index / columns), index % columns);
      meanSlopeDegrees[index] = fallback;
      maxSlopeDegrees[index] = fallback;
    }
    return { meanSlopeDegrees, maxSlopeDegrees };
  }

  const { rows: nativeRows, columns: nativeColumns, data: nativeData } = source;
  const nativeNorth = source.bounds.north;
  const nativeWest = source.bounds.west;
  const nativeLatitudeStep = source.latitudeStep;
  const nativeLongitudeStep = source.longitudeStep;
  const nativeNorthSouthMeters = nativeLatitudeStep * METERS_PER_DEGREE_LATITUDE;
  const nativeEastWestMeters = nativeLongitudeStep * metersPerDegreeLongitude(center.lat);
  const nativeAt = (row: number, column: number): number => {
    const clampedRow = clamp(row, 0, nativeRows - 1);
    const clampedColumn = clamp(column, 0, nativeColumns - 1);
    return nativeData[clampedRow * nativeColumns + clampedColumn];
  };

  const slopeSums = new Float32Array(cellCount);
  const slopeCounts = new Int32Array(cellCount);
  const slopeMax = new Float32Array(cellCount);

  for (let nativeRow = 0; nativeRow < nativeRows; nativeRow += 1) {
    const latitude = nativeNorth - nativeRow * nativeLatitudeStep;
    if (latitude < bounds.south || latitude > bounds.north) continue;
    for (let nativeColumn = 0; nativeColumn < nativeColumns; nativeColumn += 1) {
      const longitude = nativeWest + nativeColumn * nativeLongitudeStep;
      if (longitude < bounds.west || longitude > bounds.east) continue;

      const dzdx = (
        (nativeAt(nativeRow - 1, nativeColumn + 1) + 2 * nativeAt(nativeRow, nativeColumn + 1) + nativeAt(nativeRow + 1, nativeColumn + 1)) -
        (nativeAt(nativeRow - 1, nativeColumn - 1) + 2 * nativeAt(nativeRow, nativeColumn - 1) + nativeAt(nativeRow + 1, nativeColumn - 1))
      ) / (8 * nativeEastWestMeters);
      const dzdy = (
        (nativeAt(nativeRow + 1, nativeColumn - 1) + 2 * nativeAt(nativeRow + 1, nativeColumn) + nativeAt(nativeRow + 1, nativeColumn + 1)) -
        (nativeAt(nativeRow - 1, nativeColumn - 1) + 2 * nativeAt(nativeRow - 1, nativeColumn) + nativeAt(nativeRow - 1, nativeColumn + 1))
      ) / (8 * nativeNorthSouthMeters);
      const slopeDegrees = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

      const row = clamp(Math.round((bounds.north - latitude) / latitudeStep), 0, rows - 1);
      const column = clamp(Math.round((longitude - bounds.west) / longitudeStep), 0, columns - 1);
      const index = row * columns + column;
      slopeSums[index] += slopeDegrees;
      slopeCounts[index] += 1;
      if (slopeDegrees > slopeMax[index]) slopeMax[index] = slopeDegrees;
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (slopeCounts[index] > 0) {
        meanSlopeDegrees[index] = slopeSums[index] / slopeCounts[index];
        maxSlopeDegrees[index] = slopeMax[index];
        continue;
      }
      // No native sample landed here, so the source is coarser than the
      // routing grid (or absent). Fall back to the routing step itself.
      const fallback = routingFallback(row, column);
      meanSlopeDegrees[index] = fallback;
      maxSlopeDegrees[index] = fallback;
    }
  }

  return { meanSlopeDegrees, maxSlopeDegrees };
};

const NEIGHBOUR_OFFSETS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
] as const;

const buildRuggedness = (geometry: TerrainGridGeometry, elevations: Float32Array): Float32Array => {
  const { rows, columns } = geometry;
  const ruggednessMeters = new Float32Array(rows * columns);
  const at = (row: number, column: number): number =>
    elevations[clamp(row, 0, rows - 1) * columns + clamp(column, 0, columns - 1)];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const centre = elevations[row * columns + column];
      let ruggedness = 0;
      for (const [rowOffset, columnOffset] of NEIGHBOUR_OFFSETS) {
        ruggedness += Math.abs(at(row + rowOffset, column + columnOffset) - centre);
      }
      ruggednessMeters[row * columns + column] = ruggedness / NEIGHBOUR_OFFSETS.length;
    }
  }

  return ruggednessMeters;
};

export type TerrainGridArrays = {
  readonly elevationMeters: Float32Array;
  readonly waterRisk: Float32Array;
  readonly slopeMeanDegrees: Float32Array;
  readonly maxSlopeDegrees: Float32Array;
  readonly ruggednessMeters: Float32Array;
};

export type BuildTerrainGridArraysInput = {
  readonly geometry: TerrainGridGeometry;
  /** Omit for the flat "no elevation source" model. */
  readonly elevation?: RawElevationSource;
  readonly waterways: ReadonlyArray<ReadonlyArray<Coordinate>>;
};

/**
 * The whole cost of building a terrain grid, as one pure function of plain
 * data — no class, no closures over a live `ElevationGrid`. This is what
 * `terrain.worker.ts` calls off the main thread; the synchronous constructor
 * below calls the same function inline for tests and for the flat model,
 * where the cost is negligible.
 */
export const buildTerrainGridArrays = (input: BuildTerrainGridArraysInput): TerrainGridArrays => {
  const { geometry, elevation, waterways } = input;
  const { rows, columns } = geometry;
  const cellCount = rows * columns;

  const elevationMeters = new Float32Array(cellCount);
  if (elevation) {
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const { lat, lng } = coordinateAt(geometry, row, column);
        elevationMeters[row * columns + column] = sampleElevationData(elevation, lat, lng);
      }
    }
  }

  const waterRisk = rasterizeWater(geometry, waterways);
  const { meanSlopeDegrees, maxSlopeDegrees } = buildSlopeFields(geometry, elevation, elevationMeters);
  const ruggednessMeters = buildRuggedness(geometry, elevationMeters);

  return { elevationMeters, waterRisk, slopeMeanDegrees: meanSlopeDegrees, maxSlopeDegrees, ruggednessMeters };
};

class GridTerrainModel implements TerrainModel {
  readonly id: string;
  readonly name: string;
  readonly dataSource: TerrainDataSource;
  readonly center: Coordinate;
  readonly bounds: GeoBounds;
  readonly rows: number;
  readonly columns: number;
  readonly cellSizeMeters: number;
  readonly hasElevation: boolean;

  private readonly sourceElevation: ElevationGrid;
  private readonly elevationMeters: Float32Array;
  private readonly slopeMeanDegrees: Float32Array;
  private readonly maxSlopeDegrees: Float32Array;
  private readonly ruggednessMeters: Float32Array;
  private readonly waterRisk: Float32Array;
  private readonly latitudeStep: number;
  private readonly longitudeStep: number;

  constructor(options: TerrainModelOptions, precomputed?: TerrainGridArrays) {
    this.bounds = options.bounds;
    this.hasElevation = Boolean(options.elevation);
    this.sourceElevation = options.elevation ?? createFlatElevationGrid(options.bounds);
    this.dataSource = this.hasElevation ? "elevation-tiles" : "flat";
    this.id = options.id ?? "pathless-terrain-grid";

    const geometry = terrainGridGeometry(this.bounds, options.cellSizeMeters);
    this.cellSizeMeters = geometry.cellSizeMeters;
    this.center = geometry.center;
    this.rows = geometry.rows;
    this.columns = geometry.columns;
    this.latitudeStep = geometry.latitudeStep;
    this.longitudeStep = geometry.longitudeStep;
    this.name = options.name ?? `${Math.round(this.cellSizeMeters)} m terrain grid`;

    const arrays = precomputed ?? buildTerrainGridArrays({
      geometry,
      elevation: this.hasElevation ? this.sourceElevation : undefined,
      waterways: options.waterways ?? [],
    });
    this.elevationMeters = arrays.elevationMeters;
    this.waterRisk = arrays.waterRisk;
    this.slopeMeanDegrees = arrays.slopeMeanDegrees;
    this.maxSlopeDegrees = arrays.maxSlopeDegrees;
    this.ruggednessMeters = arrays.ruggednessMeters;
  }

  cellAt(row: number, column: number): TerrainCell | undefined {
    const index = this.cellIndexAt(row, column);
    if (index < 0) return undefined;
    return this.buildTerrainCell(index, row, column);
  }

  cellAtCoordinate(coordinate: Coordinate): TerrainCell {
    const index = this.cellIndexAtCoordinate(coordinate);
    const row = Math.floor(index / this.columns);
    return this.buildTerrainCell(index, row, index - row * this.columns);
  }

  cellIndexAt(row: number, column: number): number {
    if (row < 0 || row >= this.rows || column < 0 || column >= this.columns) return -1;
    return row * this.columns + column;
  }

  cellIndexAtCoordinate(coordinate: Coordinate): number {
    const row = clamp(
      Math.round((this.bounds.north - coordinate.lat) / this.latitudeStep),
      0,
      this.rows - 1,
    );
    const column = clamp(
      Math.round((coordinate.lng - this.bounds.west) / this.longitudeStep),
      0,
      this.columns - 1,
    );
    return this.cellIndexAt(row, column);
  }


  elevationOfCell(index: number): number {
    return this.elevationMeters[index];
  }

  waterRiskOfCell(index: number): number {
    return this.waterRisk[index];
  }

  maxSlopeOfCell(index: number): number {
    return this.maxSlopeDegrees[index];
  }

  contains(coordinate: Coordinate): boolean {
    return coordinate.lat >= this.bounds.south && coordinate.lat <= this.bounds.north &&
      coordinate.lng >= this.bounds.west && coordinate.lng <= this.bounds.east;
  }

  elevationAt(coordinate: Coordinate): number {
    return this.sourceElevation.sample(coordinate.lat, coordinate.lng);
  }

  private coordinateFor(row: number, column: number): Coordinate {
    return {
      lat: this.bounds.north - row * this.latitudeStep,
      lng: this.bounds.west + column * this.longitudeStep,
    };
  }

  private buildTerrainCell(
    index: number,
    row: number,
    column: number,
  ): TerrainCell {
    return {
      row,
      column,
      coordinate: this.coordinateFor(row, column),
      elevationMeters: this.elevationMeters[index],
      slopeDegrees: this.slopeMeanDegrees[index],
      maxSlopeDegrees: this.maxSlopeDegrees[index],
      ruggednessMeters: this.ruggednessMeters[index],
      waterRisk: this.waterRisk[index],
    };
  }
}

export const createTerrainModel = (options: TerrainModelOptions): TerrainModel =>
  new GridTerrainModel(options);

/** Convenience for tests and for the "elevation unavailable" path. */
export const createFlatTerrainModel = (
  bounds: GeoBounds,
  cellSizeMeters = DEFAULT_CELL_SIZE_METERS,
): TerrainModel => new GridTerrainModel({ bounds, cellSizeMeters });

/** Wrap grid arrays a worker already built, skipping the expensive step entirely. */
export const createTerrainModelFromArrays = (
  options: TerrainModelOptions,
  arrays: TerrainGridArrays,
): TerrainModel => new GridTerrainModel(options, arrays);
