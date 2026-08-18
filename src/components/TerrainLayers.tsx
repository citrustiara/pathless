import L from "leaflet";
import { useEffect, useMemo } from "react";
import { useMap } from "react-leaflet";
import { buildContours, smoothGrid, type ElevationGrid } from "../engine";

/**
 * Hypsometric tint plus a shaded relief, both computed from the elevation grid
 * and drawn once into a single raster. Rendering it as an image keeps the map
 * responsive; the vector contours on top carry the precision.
 */

type LayerProps = {
  grid: ElevationGrid;
  visible: boolean;
};

/** Hypsometric ramp, low ground to high ground. */
const RAMP: Array<[number, [number, number, number]]> = [
  [0, [58, 106, 82]],
  [0.22, [110, 152, 96]],
  [0.44, [168, 186, 116]],
  [0.64, [214, 199, 143]],
  [0.82, [200, 163, 118]],
  [1, [160, 118, 92]],
];

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

const AZIMUTH = (315 * Math.PI) / 180;
const SUN_ALTITUDE = (46 * Math.PI) / 180;
/** Vertical exaggeration; this terrain is gentle enough to need the help. */
const RELIEF_EXAGGERATION = 2.6;

const renderTerrainRaster = (grid: ElevationGrid, scale: number): string => {
  const width = Math.min(1_400, Math.round(grid.columns * scale));
  const height = Math.min(1_400, Math.round(grid.rows * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return "";

  const image = context.createImageData(width, height);
  const relief = Math.max(1, grid.maxElevation - grid.minElevation);
  const metersPerPixelX = (grid.longitudeStep * grid.columns * 111_132 *
    Math.cos((grid.bounds.north * Math.PI) / 180)) / width;
  const metersPerPixelY = (grid.latitudeStep * grid.rows * 111_132) / height;

  const heightAt = (x: number, y: number): number => grid.sample(
    grid.bounds.north - ((y + 0.5) / height) * (grid.bounds.north - grid.bounds.south),
    grid.bounds.west + ((x + 0.5) / width) * (grid.bounds.east - grid.bounds.west),
  );

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centre = heightAt(x, y);
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
      // Keep the shading gentle so the base map stays readable underneath.
      const lighting = 0.72 + shade * 0.56;
      const [red, green, blue] = rampColor((centre - grid.minElevation) / relief);
      const offset = (y * width + x) * 4;
      image.data[offset] = Math.min(255, red * lighting);
      image.data[offset + 1] = Math.min(255, green * lighting);
      image.data[offset + 2] = Math.min(255, blue * lighting);
      image.data[offset + 3] = 255;
    }
  }

  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
};

export function ElevationTintLayer({ grid, visible }: LayerProps) {
  const map = useMap();
  const dataUrl = useMemo(
    () => (grid.rows > 2 ? renderTerrainRaster(grid, 2) : ""),
    [grid],
  );

  useEffect(() => {
    if (!visible || !dataUrl) return;
    // The grid stores sample points, so the image rectangle reaches half a
    // step further out in every direction.
    const halfLatitude = grid.latitudeStep / 2;
    const halfLongitude = grid.longitudeStep / 2;
    const overlay = L.imageOverlay(
      dataUrl,
      [
        [grid.bounds.south - halfLatitude, grid.bounds.west - halfLongitude],
        [grid.bounds.north + halfLatitude, grid.bounds.east + halfLongitude],
      ],
      { opacity: 0.5, interactive: false, className: "elevation-tint-overlay", pane: "tilePane" },
    ).addTo(map);
    return () => {
      overlay.remove();
    };
  }, [dataUrl, grid, map, visible]);

  return null;
}

export type ContourStyle = {
  interval: number;
  lineCount: number;
};

type ContourLayerProps = LayerProps & {
  onStyle?: (style: ContourStyle) => void;
  interval: number;
};

export function ContourLayer({ grid, visible, interval, onStyle }: ContourLayerProps) {
  const map = useMap();
  const contours = useMemo(() => {
    if (grid.rows <= 2 || interval <= 0) return [];
    // Smoothing first keeps single-sample noise from producing crinkly lines.
    return buildContours(smoothGrid(grid, 2), interval, 5);
  }, [grid, interval]);

  useEffect(() => {
    onStyle?.({ interval, lineCount: contours.length });
  }, [contours.length, interval, onStyle]);

  useEffect(() => {
    if (!visible || contours.length === 0) return;
    const group = L.layerGroup([], { pane: "overlayPane" }).addTo(map);
    for (const contour of contours) {
      L.polyline(contour.points, {
        color: contour.index ? "#7a6142" : "#8d7a5c",
        weight: contour.index ? 1.25 : 0.7,
        opacity: contour.index ? 0.72 : 0.5,
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
