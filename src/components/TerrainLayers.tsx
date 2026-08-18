import L from "leaflet";
import { useEffect, useMemo } from "react";
import { useMap } from "react-leaflet";
import { buildContours, smoothGrid, type Coordinate, type ElevationGrid } from "../engine";

/**
 * Three ways of drawing the same elevation grid.
 *
 * The relief is a neutral grey raster blended with soft-light, so it adds depth
 * without touching the base map's own land-cover colours. The hypsometric tint
 * is a separate, optional layer precisely because it *does* replace them. The
 * contours are vectors, so they stay sharp at every zoom.
 */

type LayerProps = {
  grid: ElevationGrid;
  visible: boolean;
};

const AZIMUTH = (315 * Math.PI) / 180;
const SUN_ALTITUDE = (46 * Math.PI) / 180;
/** What flat ground returns, and so the value that must map to neutral grey. */
const FLAT_SHADE = Math.sin(SUN_ALTITUDE);
/** This terrain is gentle enough that the relief needs the help. */
const RELIEF_EXAGGERATION = 2.8;
const RELIEF_CONTRAST = 1.15;

/**
 * Hypsometric ramp, low ground to high ground. The stops span a wide hue and
 * lightness range on purpose: Sopocka is a low hill, so its whole relief
 * already gets stretched across exactly this ramp (`renderRaster` normalises
 * by the grid's own min/max, not a fixed elevation scale) — the only way for
 * that stretch to actually read as "exaggerated" on screen is for the ramp
 * itself to carry a lot of contrast between its stops.
 */
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [24, 108, 100]],
  [0.2, [58, 145, 84]],
  [0.4, [154, 191, 68]],
  [0.58, [230, 204, 68]],
  [0.75, [223, 146, 55]],
  [0.9, [193, 84, 62]],
  [1, [138, 46, 66]],
];
/** Stretches the normalised elevation away from the midpoint before ramp lookup, the same trick `RELIEF_CONTRAST` uses for shading. */
const TINT_CONTRAST = 1.5;

const rampColor = (position: number): [number, number, number] => {
  for (let index = 1; index < RAMP.length; index += 1) {
    const [stop, color] = RAMP[index];
    if (position <= stop) {
      const [previousStop, previousColor] = RAMP[index - 1];
      const span = stop - previousStop || 1;
      const t = (position - previousStop) / span;
      return [
        previousColor[0] + (color[0] - previousColor[0]) * t,
        previousColor[1] + (color[1] - previousColor[1]) * t,
        previousColor[2] + (color[2] - previousColor[2]) * t,
      ];
    }
  }
  return RAMP[RAMP.length - 1][1];
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** How far off the route counts as "close enough" to shape the tint's colour range. */
const TINT_FOCUS_BUFFER_METERS = 150;

/**
 * Elevation range within `bufferMeters` of every point in `coordinates`'s
 * bounding box, rather than the whole grid's. A route only ever covers a
 * sliver of Sopocka's full ~110 m of relief, so stretching the ramp to the
 * *route's* local relief instead makes every rise and dip along it read as
 * clearly as the hillside is exaggerated overall — ground far from the
 * route is free to clip to the ramp's extremes, since it isn't what's being
 * judged.
 */
const localElevationRange = (
  grid: ElevationGrid,
  coordinates: readonly Coordinate[] | undefined,
  bufferMeters: number,
): { min: number; max: number } => {
  const fallback = { min: grid.minElevation, max: grid.maxElevation };
  if (!coordinates || coordinates.length === 0) return fallback;

  let south = Number.POSITIVE_INFINITY, north = Number.NEGATIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY, east = Number.NEGATIVE_INFINITY;
  for (const { lat, lng } of coordinates) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
  }
  const latBuffer = bufferMeters / 111_320;
  const lngBuffer = bufferMeters / (111_320 * Math.cos(((north + south) / 2) * (Math.PI / 180)));
  const rowFor = (lat: number): number =>
    Math.min(Math.max(Math.round((grid.bounds.north - lat) / grid.latitudeStep), 0), grid.rows - 1);
  const columnFor = (lng: number): number =>
    Math.min(Math.max(Math.round((lng - grid.bounds.west) / grid.longitudeStep), 0), grid.columns - 1);
  const rowStart = rowFor(north + latBuffer);
  const rowEnd = rowFor(south - latBuffer);
  const columnStart = columnFor(west - lngBuffer);
  const columnEnd = columnFor(east + lngBuffer);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let row = rowStart; row <= rowEnd; row += 1) {
    for (let column = columnStart; column <= columnEnd; column += 1) {
      const value = grid.data[row * grid.columns + column];
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  // A degenerate window (a single-point route, or one narrower than a cell)
  // falls back rather than dividing by a near-zero span.
  return Number.isFinite(min) && Number.isFinite(max) && max - min >= 1 ? { min, max } : fallback;
};

type RasterOptions = {
  scale: number;
  /** Colour by elevation instead of producing a neutral relief. */
  hypsometric: boolean;
  /** Overrides the grid's own min/max for the hypsometric ramp. */
  elevationRange?: { min: number; max: number };
};

const renderRaster = (grid: ElevationGrid, options: RasterOptions): string => {
  const width = Math.min(1_400, Math.round(grid.columns * options.scale));
  const height = Math.min(1_400, Math.round(grid.rows * options.scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return "";

  const image = context.createImageData(width, height);
  const rangeMin = options.elevationRange?.min ?? grid.minElevation;
  const rangeMax = options.elevationRange?.max ?? grid.maxElevation;
  const relief = Math.max(1, rangeMax - rangeMin);
  // Fade the border so the working area does not read as a pasted-on box.
  const featherX = Math.max(1, width * 0.035);
  const featherY = Math.max(1, height * 0.035);
  const metersPerPixelX = (grid.longitudeStep * grid.columns * 111_132 *
    Math.cos((grid.bounds.north * Math.PI) / 180)) / width;
  const metersPerPixelY = (grid.latitudeStep * grid.rows * 111_132) / height;

  const heightAt = (x: number, y: number): number => grid.sample(
    grid.bounds.north - ((y + 0.5) / height) * (grid.bounds.north - grid.bounds.south),
    grid.bounds.west + ((x + 0.5) / width) * (grid.bounds.east - grid.bounds.west),
  );

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const edge = Math.min(
        x / featherX, (width - 1 - x) / featherX,
        y / featherY, (height - 1 - y) / featherY,
        1,
      );
      image.data[offset + 3] = Math.round(255 * edge);

      if (options.hypsometric) {
        const position = (heightAt(x, y) - rangeMin) / relief;
        const stretched = clamp01(0.5 + (position - 0.5) * TINT_CONTRAST);
        const [red, green, blue] = rampColor(stretched);
        image.data[offset] = red;
        image.data[offset + 1] = green;
        image.data[offset + 2] = blue;
        continue;
      }

      const dzdx = (heightAt(Math.min(x + 1, width - 1), y) - heightAt(Math.max(x - 1, 0), y)) /
        (2 * metersPerPixelX) * RELIEF_EXAGGERATION;
      const dzdy = (heightAt(x, Math.min(y + 1, height - 1)) - heightAt(x, Math.max(y - 1, 0))) /
        (2 * metersPerPixelY) * RELIEF_EXAGGERATION;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const shade = Math.max(
        0,
        Math.sin(SUN_ALTITUDE) * Math.cos(slope) +
          Math.cos(SUN_ALTITUDE) * Math.sin(slope) * Math.cos(AZIMUTH - aspect),
      );
      // Mid grey leaves the base map untouched under soft-light; ground facing
      // away from the sun goes darker, ground facing it goes lighter.
      const grey = clamp01(0.5 + (shade - FLAT_SHADE) * RELIEF_CONTRAST) * 255;
      image.data[offset] = grey;
      image.data[offset + 1] = grey;
      image.data[offset + 2] = grey;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
};

const useRasterOverlay = (
  grid: ElevationGrid,
  visible: boolean,
  className: string,
  opacity: number,
  hypsometric: boolean,
  elevationRange?: { min: number; max: number },
): null => {
  const map = useMap();
  const dataUrl = useMemo(
    () => (grid.rows > 2 ? renderRaster(grid, { scale: 2, hypsometric, elevationRange }) : ""),
    [grid, hypsometric, elevationRange],
  );

  useEffect(() => {
    if (!visible || !dataUrl) return;
    // The grid holds sample points, so the image rectangle reaches half a step
    // further out in every direction.
    const halfLatitude = grid.latitudeStep / 2;
    const halfLongitude = grid.longitudeStep / 2;
    const overlay = L.imageOverlay(
      dataUrl,
      [
        [grid.bounds.south - halfLatitude, grid.bounds.west - halfLongitude],
        [grid.bounds.north + halfLatitude, grid.bounds.east + halfLongitude],
      ],
      { opacity, interactive: false, className, pane: "tilePane" },
    ).addTo(map);
    return () => {
      overlay.remove();
    };
  }, [className, dataUrl, grid, map, opacity, visible]);

  return null;
};

export function HillshadeLayer({ grid, visible }: LayerProps) {
  return useRasterOverlay(grid, visible, "hillshade-overlay", 0.9, false);
}

type ElevationTintLayerProps = LayerProps & {
  /** Typically the current route: shapes the tint's colour range to the terrain around it. */
  focusCoordinates?: readonly Coordinate[];
};

export function ElevationTintLayer({ grid, visible, focusCoordinates }: ElevationTintLayerProps) {
  const elevationRange = useMemo(
    () => localElevationRange(grid, focusCoordinates, TINT_FOCUS_BUFFER_METERS),
    [grid, focusCoordinates],
  );
  return useRasterOverlay(grid, visible, "elevation-tint-overlay", 0.58, true, elevationRange);
}

type ContourLayerProps = LayerProps & {
  interval: number;
};

export function ContourLayer({ grid, visible, interval }: ContourLayerProps) {
  const map = useMap();
  const contours = useMemo(() => {
    if (grid.rows <= 2 || interval <= 0) return [];
    // Smoothing first keeps single-sample noise from producing crinkly lines.
    return buildContours(smoothGrid(grid, 2), interval, 5);
  }, [grid, interval]);

  useEffect(() => {
    if (!visible || contours.length === 0) return;
    const group = L.layerGroup([], { pane: "overlayPane" }).addTo(map);
    for (const contour of contours) {
      L.polyline(contour.points, {
        color: contour.index ? "#6f5738" : "#87724f",
        weight: contour.index ? 1.4 : 0.85,
        opacity: contour.index ? 0.82 : 0.58,
        interactive: false,
        lineJoin: "round",
        lineCap: "round",
      }).addTo(group);
    }
    return () => {
      group.remove();
    };
  }, [contours, map, visible]);

  return null;
}
