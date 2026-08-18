/**
 * The routing terrain model.
 *
 * This is a coarse regular grid laid over the working area, filled from a real
 * elevation grid plus the mapped watercourses from OSM. Nothing in here is
 * invented: if the elevation source is unavailable the model reports
 * `hasElevation: false` and stays flat, and the UI is expected to say so.
 */
import {
  clamp,
  distanceBetweenCoordinates,
  METERS_PER_DEGREE_LATITUDE,
  metersPerDegreeLongitude,
} from "./geo";
import type { ElevationGrid } from "./elevation";
import { createFlatElevationGrid } from "./elevation";
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
  readonly cells: readonly TerrainCell[];

  private readonly elevation: ElevationGrid;
  private readonly latitudeStep: number;
  private readonly longitudeStep: number;

  constructor(options: TerrainModelOptions) {
    this.bounds = options.bounds;
    this.hasElevation = Boolean(options.elevation);
    this.elevation = options.elevation ?? createFlatElevationGrid(options.bounds);
    this.dataSource = this.hasElevation ? "elevation-tiles" : "flat";
    this.cellSizeMeters = Math.max(5, options.cellSizeMeters ?? DEFAULT_CELL_SIZE_METERS);
    this.center = {
      lat: (this.bounds.north + this.bounds.south) / 2,
      lng: (this.bounds.east + this.bounds.west) / 2,
    };
    this.id = options.id ?? "pathless-terrain-grid";
    this.name = options.name ?? `${Math.round(this.cellSizeMeters)} m terrain grid`;

    const heightMeters = (this.bounds.north - this.bounds.south) * METERS_PER_DEGREE_LATITUDE;
    const widthMeters = (this.bounds.east - this.bounds.west) *
      metersPerDegreeLongitude(this.center.lat);
    this.rows = Math.max(3, Math.round(heightMeters / this.cellSizeMeters) + 1);
    this.columns = Math.max(3, Math.round(widthMeters / this.cellSizeMeters) + 1);
    this.latitudeStep = (this.bounds.north - this.bounds.south) / (this.rows - 1);
    this.longitudeStep = (this.bounds.east - this.bounds.west) / (this.columns - 1);

    const elevations = new Float32Array(this.rows * this.columns);
    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const { lat, lng } = this.coordinateFor(row, column);
        elevations[row * this.columns + column] = this.elevation.sample(lat, lng);
      }
    }

    const waterRisk = this.rasterizeWater(options.waterways ?? []);
    const { meanSlopeDegrees, maxSlopeDegrees } = this.buildSlopeFields(elevations);
    this.cells = this.buildCells(elevations, waterRisk, meanSlopeDegrees, maxSlopeDegrees);
  }

  cellAt(row: number, column: number): TerrainCell | undefined {
    if (row < 0 || row >= this.rows || column < 0 || column >= this.columns) return undefined;
    return this.cells[row * this.columns + column];
  }

  cellAtCoordinate(coordinate: Coordinate): TerrainCell {
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
    return this.cells[row * this.columns + column];
  }

  contains(coordinate: Coordinate): boolean {
    return coordinate.lat >= this.bounds.south && coordinate.lat <= this.bounds.north &&
      coordinate.lng >= this.bounds.west && coordinate.lng <= this.bounds.east;
  }

  elevationAt(coordinate: Coordinate): number {
    return this.elevation.sample(coordinate.lat, coordinate.lng);
  }

  private coordinateFor(row: number, column: number): Coordinate {
    return {
      lat: this.bounds.north - row * this.latitudeStep,
      lng: this.bounds.west + column * this.longitudeStep,
    };
  }

  /**
   * Stamp a decaying disc around every mapped watercourse. Walking the lines is
   * far cheaper than testing each cell against every segment.
   */
  private rasterizeWater(waterways: ReadonlyArray<ReadonlyArray<Coordinate>>): Float32Array {
    const risk = new Float32Array(this.rows * this.columns);
    const radiusInCells = Math.ceil(WATER_INFLUENCE_METERS / this.cellSizeMeters);
    const step = Math.max(4, this.cellSizeMeters / 2);

    const stamp = (point: Coordinate): void => {
      const centreRow = Math.round((this.bounds.north - point.lat) / this.latitudeStep);
      const centreColumn = Math.round((point.lng - this.bounds.west) / this.longitudeStep);
      for (let row = centreRow - radiusInCells; row <= centreRow + radiusInCells; row += 1) {
        if (row < 0 || row >= this.rows) continue;
        for (let column = centreColumn - radiusInCells; column <= centreColumn + radiusInCells; column += 1) {
          if (column < 0 || column >= this.columns) continue;
          const distance = distanceBetweenCoordinates(point, this.coordinateFor(row, column));
          const value = clamp(1 - distance / WATER_INFLUENCE_METERS, 0, 1);
          const index = row * this.columns + column;
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
  }

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
  private buildSlopeFields(elevations: Float32Array): {
    meanSlopeDegrees: Float32Array;
    maxSlopeDegrees: Float32Array;
  } {
    const cellCount = this.rows * this.columns;
    const nativeRows = this.elevation.rows;
    const nativeColumns = this.elevation.columns;
    const nativeData = this.elevation.data;
    const nativeNorth = this.elevation.bounds.north;
    const nativeWest = this.elevation.bounds.west;
    const nativeLatitudeStep = this.elevation.latitudeStep;
    const nativeLongitudeStep = this.elevation.longitudeStep;
    const nativeNorthSouthMeters = nativeLatitudeStep * METERS_PER_DEGREE_LATITUDE;
    const nativeEastWestMeters =
      nativeLongitudeStep * metersPerDegreeLongitude(this.center.lat);
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
      if (latitude < this.bounds.south || latitude > this.bounds.north) continue;
      for (let nativeColumn = 0; nativeColumn < nativeColumns; nativeColumn += 1) {
        const longitude = nativeWest + nativeColumn * nativeLongitudeStep;
        if (longitude < this.bounds.west || longitude > this.bounds.east) continue;

        const dzdx = (
          (nativeAt(nativeRow - 1, nativeColumn + 1) + 2 * nativeAt(nativeRow, nativeColumn + 1) + nativeAt(nativeRow + 1, nativeColumn + 1)) -
          (nativeAt(nativeRow - 1, nativeColumn - 1) + 2 * nativeAt(nativeRow, nativeColumn - 1) + nativeAt(nativeRow + 1, nativeColumn - 1))
        ) / (8 * nativeEastWestMeters);
        const dzdy = (
          (nativeAt(nativeRow + 1, nativeColumn - 1) + 2 * nativeAt(nativeRow + 1, nativeColumn) + nativeAt(nativeRow + 1, nativeColumn + 1)) -
          (nativeAt(nativeRow - 1, nativeColumn - 1) + 2 * nativeAt(nativeRow - 1, nativeColumn) + nativeAt(nativeRow - 1, nativeColumn + 1))
        ) / (8 * nativeNorthSouthMeters);
        const slopeDegrees = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;

        const row = clamp(
          Math.round((this.bounds.north - latitude) / this.latitudeStep),
          0,
          this.rows - 1,
        );
        const column = clamp(
          Math.round((longitude - this.bounds.west) / this.longitudeStep),
          0,
          this.columns - 1,
        );
        const index = row * this.columns + column;
        slopeSums[index] += slopeDegrees;
        slopeCounts[index] += 1;
        if (slopeDegrees > slopeMax[index]) slopeMax[index] = slopeDegrees;
      }
    }

    const meanSlopeDegrees = new Float32Array(cellCount);
    const maxSlopeDegrees = new Float32Array(cellCount);
    const routingNorthSouthMeters = this.latitudeStep * METERS_PER_DEGREE_LATITUDE;
    const routingEastWestMeters = this.longitudeStep * metersPerDegreeLongitude(this.center.lat);
    const routingAt = (row: number, column: number): number =>
      elevations[clamp(row, 0, this.rows - 1) * this.columns + clamp(column, 0, this.columns - 1)];

    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const index = row * this.columns + column;
        if (slopeCounts[index] > 0) {
          meanSlopeDegrees[index] = slopeSums[index] / slopeCounts[index];
          maxSlopeDegrees[index] = slopeMax[index];
          continue;
        }
        // No native sample landed here, so the source is coarser than the
        // routing grid (or absent). Fall back to the routing step itself.
        const dzdx = (
          (routingAt(row - 1, column + 1) + 2 * routingAt(row, column + 1) + routingAt(row + 1, column + 1)) -
          (routingAt(row - 1, column - 1) + 2 * routingAt(row, column - 1) + routingAt(row + 1, column - 1))
        ) / (8 * routingEastWestMeters);
        const dzdy = (
          (routingAt(row + 1, column - 1) + 2 * routingAt(row + 1, column) + routingAt(row + 1, column + 1)) -
          (routingAt(row - 1, column - 1) + 2 * routingAt(row - 1, column) + routingAt(row - 1, column + 1))
        ) / (8 * routingNorthSouthMeters);
        const fallback = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
        meanSlopeDegrees[index] = fallback;
        maxSlopeDegrees[index] = fallback;
      }
    }

    return { meanSlopeDegrees, maxSlopeDegrees };
  }

  private buildCells(
    elevations: Float32Array,
    waterRisk: Float32Array,
    meanSlopeDegrees: Float32Array,
    maxSlopeDegrees: Float32Array,
  ): TerrainCell[] {
    const cells: TerrainCell[] = [];
    const at = (row: number, column: number): number =>
      elevations[clamp(row, 0, this.rows - 1) * this.columns + clamp(column, 0, this.columns - 1)];
    const indexFor = (row: number, column: number): number => row * this.columns + column;

    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const index = indexFor(row, column);
        const centre = elevations[row * this.columns + column];
        let ruggedness = 0;
        for (const [rowOffset, columnOffset] of NEIGHBOUR_OFFSETS) {
          ruggedness += Math.abs(at(row + rowOffset, column + columnOffset) - centre);
        }

        cells.push({
          row,
          column,
          coordinate: this.coordinateFor(row, column),
          elevationMeters: centre,
          slopeDegrees: meanSlopeDegrees[index],
          maxSlopeDegrees: maxSlopeDegrees[index],
          ruggednessMeters: ruggedness / NEIGHBOUR_OFFSETS.length,
          waterRisk: waterRisk[index],
        });
      }
    }

    return cells;
  }
}

const NEIGHBOUR_OFFSETS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
] as const;

export const createTerrainModel = (options: TerrainModelOptions): TerrainModel =>
  new GridTerrainModel(options);

/** Convenience for tests and for the "elevation unavailable" path. */
export const createFlatTerrainModel = (
  bounds: GeoBounds,
  cellSizeMeters = DEFAULT_CELL_SIZE_METERS,
): TerrainModel => new GridTerrainModel({ bounds, cellSizeMeters });
