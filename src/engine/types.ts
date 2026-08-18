/**
 * Public types for the Pathless routing core.
 *
 * Coordinates are WGS84 latitude/longitude pairs. Distances and elevations are
 * expressed in metres; times are expressed in minutes.
 */

export type Coordinate = {
  lat: number;
  lng: number;
};

export interface GeoBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Base travel style. Speeds are derived from this plus the real local grade. */
export type ActivityProfile = "hiker" | "runner" | "mtb";

/**
 * Where the elevation behind a terrain model came from.
 *
 * `flat` means no elevation was available: the model reports zero relief and
 * the UI must say so rather than showing invented ascent figures.
 */
export type TerrainDataSource = "elevation-tiles" | "flat";

export interface TerrainCell {
  readonly row: number;
  readonly column: number;
  readonly coordinate: Coordinate;
  readonly elevationMeters: number;
  /**
   * MEAN ground slope inside the cell, in degrees.
   *
   * The value is measured from the underlying elevation source and then reduced
   * into one value for this routing cell.
   */
  readonly slopeDegrees: number;
  /**
   * Steepest slope found anywhere inside the cell, in degrees.
   *
   * This uses the same source data and resolution as the mean slope and can still
   * be high when the mean remains relatively gentle.
   */
  readonly maxSlopeDegrees: number;
  /**
   * Terrain Ruggedness Index in metres: the mean absolute elevation difference
   * to the eight neighbours. This measures the *shape* of the ground only and
   * says nothing about vegetation, deadfall, or undergrowth.
  */
  readonly ruggednessMeters: number;
  /** Distance-decayed proximity to a mapped watercourse, in [0, 1]. */
  readonly waterRisk: number;
}

export interface TerrainModel {
  readonly id: string;
  readonly name: string;
  readonly dataSource: TerrainDataSource;
  readonly center: Coordinate;
  readonly bounds: GeoBounds;
  readonly rows: number;
  readonly columns: number;
  readonly cellSizeMeters: number;
  /** False for the flat fallback, so callers can hide elevation-derived output. */
  readonly hasElevation: boolean;
  readonly cells: readonly TerrainCell[];
  cellAt(row: number, column: number): TerrainCell | undefined;
  cellAtCoordinate(coordinate: Coordinate): TerrainCell;
  contains(coordinate: Coordinate): boolean;
  /** Bilinearly interpolated elevation, smoother than the nearest cell value. */
  elevationAt(coordinate: Coordinate): number;
}
