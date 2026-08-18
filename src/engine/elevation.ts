/**
 * Real elevation for the working area.
 *
 * Samples are decoded from the public AWS "terrarium" terrain tiles, which
 * encode height directly in the pixel values:
 *
 *     metres = red * 256 + green + blue / 256 - 32768
 *
 * The tiles are Web Mercator, but the grid built here is regular in
 * latitude/longitude so that a raster overlay lines up with Leaflet without a
 * reprojection step, and so `sample()` stays a plain bilinear lookup.
 */
import { clamp, METERS_PER_DEGREE_LATITUDE, metersPerDegreeLongitude } from "./geo";
import type { GeoBounds } from "./types";

const TILE_SIZE = 256;
const TERRARIUM_TEMPLATE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** ~11 m per pixel at 54° N, which is finer than the source DEM itself. */
const DEFAULT_TILE_ZOOM = 13;
const DEFAULT_SAMPLE_SPACING_METERS = 12;
const REQUEST_TIMEOUT_MS = 12_000;

export type ElevationGrid = {
  readonly bounds: GeoBounds;
  readonly rows: number;
  readonly columns: number;
  /** Row 0 is the northern edge; column 0 is the western edge. */
  readonly data: Float32Array;
  readonly latitudeStep: number;
  readonly longitudeStep: number;
  readonly minElevation: number;
  readonly maxElevation: number;
  readonly attribution: string;
  /** Bilinear sample, clamped to the grid edges. */
  sample(lat: number, lng: number): number;
};

const longitudeToTileX = (lng: number, zoom: number): number =>
  ((lng + 180) / 360) * 2 ** zoom;

const latitudeToTileY = (lat: number, zoom: number): number => {
  const sine = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * 2 ** zoom;
};

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    const timer = window.setTimeout(() => reject(new Error(`Timed out loading ${url}`)), REQUEST_TIMEOUT_MS);
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => {
      window.clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error(`Failed to load ${url}`));
    };
    image.src = url;
  });

const tileUrl = (zoom: number, x: number, y: number): string =>
  TERRARIUM_TEMPLATE.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));

/** Decode the tile mosaic covering `bounds` into a Web Mercator pixel raster. */
const loadTileMosaic = async (bounds: GeoBounds, zoom: number) => {
  const minTileX = Math.floor(longitudeToTileX(bounds.west, zoom));
  const maxTileX = Math.floor(longitudeToTileX(bounds.east, zoom));
  const minTileY = Math.floor(latitudeToTileY(bounds.north, zoom));
  const maxTileY = Math.floor(latitudeToTileY(bounds.south, zoom));
  const tilesAcross = maxTileX - minTileX + 1;
  const tilesDown = maxTileY - minTileY + 1;

  const canvas = document.createElement("canvas");
  canvas.width = tilesAcross * TILE_SIZE;
  canvas.height = tilesDown * TILE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D context unavailable");

  const requests: Array<Promise<void>> = [];
  for (let x = minTileX; x <= maxTileX; x += 1) {
    for (let y = minTileY; y <= maxTileY; y += 1) {
      requests.push(
        loadImage(tileUrl(zoom, x, y)).then((image) => {
          context.drawImage(image, (x - minTileX) * TILE_SIZE, (y - minTileY) * TILE_SIZE);
        }),
      );
    }
  }
  await Promise.all(requests);

  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const heights = new Float32Array(canvas.width * canvas.height);
  for (let index = 0; index < heights.length; index += 1) {
    const offset = index * 4;
    heights[index] = data[offset] * 256 + data[offset + 1] + data[offset + 2] / 256 - 32_768;
  }

  return {
    heights,
    width: canvas.width,
    height: canvas.height,
    originX: minTileX * TILE_SIZE,
    originY: minTileY * TILE_SIZE,
  };
};

type TileMosaic = Awaited<ReturnType<typeof loadTileMosaic>>;

const sampleMosaic = (mosaic: TileMosaic, pixelX: number, pixelY: number): number => {
  const x = clamp(pixelX - mosaic.originX, 0, mosaic.width - 1);
  const y = clamp(pixelY - mosaic.originY, 0, mosaic.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = Math.min(x0 + 1, mosaic.width - 1);
  const y1 = Math.min(y0 + 1, mosaic.height - 1);
  const topLeft = mosaic.heights[y0 * mosaic.width + x0];
  const topRight = mosaic.heights[y0 * mosaic.width + x1];
  const bottomLeft = mosaic.heights[y1 * mosaic.width + x0];
  const bottomRight = mosaic.heights[y1 * mosaic.width + x1];
  return (
    topLeft * (1 - fx) * (1 - fy) +
    topRight * fx * (1 - fy) +
    bottomLeft * (1 - fx) * fy +
    bottomRight * fx * fy
  );
};

const buildGrid = (
  bounds: GeoBounds,
  rows: number,
  columns: number,
  data: Float32Array,
  attribution: string,
): ElevationGrid => {
  const latitudeStep = (bounds.north - bounds.south) / (rows - 1);
  const longitudeStep = (bounds.east - bounds.west) / (columns - 1);
  let minElevation = Number.POSITIVE_INFINITY;
  let maxElevation = Number.NEGATIVE_INFINITY;
  for (const value of data) {
    if (value < minElevation) minElevation = value;
    if (value > maxElevation) maxElevation = value;
  }

  return {
    bounds,
    rows,
    columns,
    data,
    latitudeStep,
    longitudeStep,
    minElevation: Number.isFinite(minElevation) ? minElevation : 0,
    maxElevation: Number.isFinite(maxElevation) ? maxElevation : 0,
    attribution,
    sample(lat: number, lng: number): number {
      const rowPosition = clamp((bounds.north - lat) / latitudeStep, 0, rows - 1);
      const columnPosition = clamp((lng - bounds.west) / longitudeStep, 0, columns - 1);
      const row0 = Math.floor(rowPosition);
      const column0 = Math.floor(columnPosition);
      const row1 = Math.min(row0 + 1, rows - 1);
      const column1 = Math.min(column0 + 1, columns - 1);
      const fr = rowPosition - row0;
      const fc = columnPosition - column0;
      return (
        data[row0 * columns + column0] * (1 - fc) * (1 - fr) +
        data[row0 * columns + column1] * fc * (1 - fr) +
        data[row1 * columns + column0] * (1 - fc) * fr +
        data[row1 * columns + column1] * fc * fr
      );
    },
  };
};

/** Wrap an existing height array as a grid. Row 0 is the northern edge. */
export const createElevationGrid = (
  bounds: GeoBounds,
  rows: number,
  columns: number,
  data: Float32Array,
  attribution = "Supplied elevation samples",
): ElevationGrid => buildGrid(bounds, rows, columns, data, attribution);

/** A grid of zeroes, used when the tiles cannot be reached. */
export const createFlatElevationGrid = (bounds: GeoBounds): ElevationGrid =>
  buildGrid(bounds, 2, 2, new Float32Array(4), "No elevation source reachable");

export type LoadElevationOptions = {
  /** Target spacing of the output grid, in metres. */
  spacingMeters?: number;
  zoom?: number;
};

/**
 * Fetch and resample real elevation for `bounds`. Rejects if the tiles cannot
 * be decoded, so the caller can decide between retrying and going flat.
 */
export const loadElevationGrid = async (
  bounds: GeoBounds,
  options: LoadElevationOptions = {},
): Promise<ElevationGrid> => {
  const zoom = options.zoom ?? DEFAULT_TILE_ZOOM;
  const spacing = Math.max(4, options.spacingMeters ?? DEFAULT_SAMPLE_SPACING_METERS);
  const centreLatitude = (bounds.north + bounds.south) / 2;
  const heightMeters = (bounds.north - bounds.south) * METERS_PER_DEGREE_LATITUDE;
  const widthMeters = (bounds.east - bounds.west) * metersPerDegreeLongitude(centreLatitude);
  const rows = clamp(Math.round(heightMeters / spacing) + 1, 16, 900);
  const columns = clamp(Math.round(widthMeters / spacing) + 1, 16, 900);

  const mosaic = await loadTileMosaic(bounds, zoom);
  const data = new Float32Array(rows * columns);
  const latitudeStep = (bounds.north - bounds.south) / (rows - 1);
  const longitudeStep = (bounds.east - bounds.west) / (columns - 1);
  for (let row = 0; row < rows; row += 1) {
    const lat = bounds.north - row * latitudeStep;
    const pixelY = latitudeToTileY(lat, zoom) * TILE_SIZE;
    for (let column = 0; column < columns; column += 1) {
      const lng = bounds.west + column * longitudeStep;
      const pixelX = longitudeToTileX(lng, zoom) * TILE_SIZE;
      data[row * columns + column] = sampleMosaic(mosaic, pixelX, pixelY);
    }
  }

  return buildGrid(bounds, rows, columns, data, "Elevation: AWS Terrain Tiles (SRTM, EU-DEM)");
};

/** Separable 3-tap blur; removes single-sample noise before contouring. */
export const smoothGrid = (grid: ElevationGrid, passes = 1): ElevationGrid => {
  const { rows, columns } = grid;
  let source = grid.data;
  for (let pass = 0; pass < passes; pass += 1) {
    const horizontal = new Float32Array(source.length);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = source[row * columns + Math.max(0, column - 1)];
        const centre = source[row * columns + column];
        const right = source[row * columns + Math.min(columns - 1, column + 1)];
        horizontal[row * columns + column] = (left + 2 * centre + right) / 4;
      }
    }
    const vertical = new Float32Array(source.length);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const up = horizontal[Math.max(0, row - 1) * columns + column];
        const centre = horizontal[row * columns + column];
        const down = horizontal[Math.min(rows - 1, row + 1) * columns + column];
        vertical[row * columns + column] = (up + 2 * centre + down) / 4;
      }
    }
    source = vertical;
  }
  return buildGrid(grid.bounds, rows, columns, source, grid.attribution);
};

export type ContourLine = {
  readonly elevation: number;
  /** Index contours are the labelled, heavier lines every fifth interval. */
  readonly index: boolean;
  /** Leaflet-ready `[lat, lng]` pairs. */
  readonly points: Array<[number, number]>;
};

type Segment = { a: [number, number]; b: [number, number] };

const KEY_PRECISION = 1e6;
const pointKey = (point: [number, number]): string =>
  `${Math.round(point[0] * KEY_PRECISION)}:${Math.round(point[1] * KEY_PRECISION)}`;

/** Marching squares over one threshold, returning unordered segments. */
const marchingSquares = (
  grid: ElevationGrid,
  threshold: number,
): Segment[] => {
  const { rows, columns, data, bounds, latitudeStep, longitudeStep } = grid;
  const segments: Segment[] = [];
  const latitudeFor = (row: number): number => bounds.north - row * latitudeStep;
  const longitudeFor = (column: number): number => bounds.west + column * longitudeStep;

  // Edge crossings, interpolated between the two corner heights.
  const top = (row: number, column: number, a: number, b: number): [number, number] =>
    [latitudeFor(row), longitudeFor(column + (threshold - a) / (b - a))];
  const bottom = (row: number, column: number, a: number, b: number): [number, number] =>
    [latitudeFor(row + 1), longitudeFor(column + (threshold - a) / (b - a))];
  const left = (row: number, column: number, a: number, b: number): [number, number] =>
    [latitudeFor(row + (threshold - a) / (b - a)), longitudeFor(column)];
  const right = (row: number, column: number, a: number, b: number): [number, number] =>
    [latitudeFor(row + (threshold - a) / (b - a)), longitudeFor(column + 1)];

  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const northWest = data[row * columns + column];
      const northEast = data[row * columns + column + 1];
      const southWest = data[(row + 1) * columns + column];
      const southEast = data[(row + 1) * columns + column + 1];

      let code = 0;
      if (northWest >= threshold) code |= 8;
      if (northEast >= threshold) code |= 4;
      if (southEast >= threshold) code |= 2;
      if (southWest >= threshold) code |= 1;
      if (code === 0 || code === 15) continue;

      const topPoint = () => top(row, column, northWest, northEast);
      const bottomPoint = () => bottom(row, column, southWest, southEast);
      const leftPoint = () => left(row, column, northWest, southWest);
      const rightPoint = () => right(row, column, northEast, southEast);

      switch (code) {
        case 1: case 14: segments.push({ a: leftPoint(), b: bottomPoint() }); break;
        case 2: case 13: segments.push({ a: bottomPoint(), b: rightPoint() }); break;
        case 3: case 12: segments.push({ a: leftPoint(), b: rightPoint() }); break;
        case 4: case 11: segments.push({ a: topPoint(), b: rightPoint() }); break;
        case 6: case 9: segments.push({ a: topPoint(), b: bottomPoint() }); break;
        case 7: case 8: segments.push({ a: leftPoint(), b: topPoint() }); break;
        case 5: case 10: {
          // Saddle: the cell centre decides which way the two lines bend.
          const centre = (northWest + northEast + southWest + southEast) / 4;
          const flipped = code === 5 ? centre < threshold : centre >= threshold;
          if (flipped) {
            segments.push({ a: leftPoint(), b: topPoint() });
            segments.push({ a: bottomPoint(), b: rightPoint() });
          } else {
            segments.push({ a: leftPoint(), b: bottomPoint() });
            segments.push({ a: topPoint(), b: rightPoint() });
          }
          break;
        }
      }
    }
  }

  return segments;
};

/** Join shared endpoints into the longest polylines we can form. */
const stitchSegments = (segments: Segment[]): Array<Array<[number, number]>> => {
  const byEndpoint = new Map<string, Segment[]>();
  const used = new Set<Segment>();
  for (const segment of segments) {
    for (const key of [pointKey(segment.a), pointKey(segment.b)]) {
      const bucket = byEndpoint.get(key);
      if (bucket) bucket.push(segment);
      else byEndpoint.set(key, [segment]);
    }
  }

  const extend = (points: Array<[number, number]>, append: boolean): void => {
    while (true) {
      const tip = append ? points[points.length - 1] : points[0];
      const next = (byEndpoint.get(pointKey(tip)) ?? []).find((candidate) => !used.has(candidate));
      if (!next) return;
      used.add(next);
      const other = pointKey(next.a) === pointKey(tip) ? next.b : next.a;
      if (append) points.push(other);
      else points.unshift(other);
    }
  };

  const lines: Array<Array<[number, number]>> = [];
  for (const segment of segments) {
    if (used.has(segment)) continue;
    used.add(segment);
    const points: Array<[number, number]> = [segment.a, segment.b];
    extend(points, true);
    extend(points, false);
    if (points.length > 1) lines.push(points);
  }
  return lines;
};

/** Douglas–Peucker in degree space; the tolerance is tiny, so planar is fine. */
const simplify = (
  points: Array<[number, number]>,
  tolerance: number,
): Array<[number, number]> => {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    if (last - first < 2) continue;
    const [firstLat, firstLng] = points[first];
    const [lastLat, lastLng] = points[last];
    const dLat = lastLat - firstLat;
    const dLng = lastLng - firstLng;
    const lengthSquared = dLat * dLat + dLng * dLng;
    let worst = -1;
    let worstDistance = 0;
    for (let index = first + 1; index < last; index += 1) {
      const [lat, lng] = points[index];
      const projection = lengthSquared === 0
        ? 0
        : clamp(((lat - firstLat) * dLat + (lng - firstLng) * dLng) / lengthSquared, 0, 1);
      const distance = Math.hypot(
        lat - (firstLat + projection * dLat),
        lng - (firstLng + projection * dLng),
      );
      if (distance > worstDistance) {
        worstDistance = distance;
        worst = index;
      }
    }
    if (worstDistance > tolerance && worst > 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  return points.filter((_, index) => keep[index] === 1);
};

/** A contour interval that keeps roughly 8-20 lines on screen. */
export const suggestContourInterval = (grid: ElevationGrid): number => {
  const relief = grid.maxElevation - grid.minElevation;
  const candidates = [1, 2, 2.5, 5, 10, 20, 25, 50, 100];
  return candidates.find((interval) => relief / interval <= 22) ?? 200;
};

export const buildContours = (
  grid: ElevationGrid,
  interval: number,
  minimumPoints = 4,
): ContourLine[] => {
  if (!Number.isFinite(interval) || interval <= 0) return [];
  const tolerance = Math.min(grid.latitudeStep, grid.longitudeStep) * 0.35;
  const lines: ContourLine[] = [];
  const first = Math.ceil(grid.minElevation / interval) * interval;

  for (let elevation = first; elevation <= grid.maxElevation; elevation += interval) {
    const stitched = stitchSegments(marchingSquares(grid, elevation));
    // Index every fifth line, referenced to zero so the set is stable as the
    // viewport (and therefore the min/max) changes.
    const index = Math.round(elevation / interval) % 5 === 0;
    for (const line of stitched) {
      if (line.length < minimumPoints) continue;
      lines.push({
        elevation: Math.round(elevation * 100) / 100,
        index,
        points: simplify(line, tolerance),
      });
    }
  }

  return lines;
};
