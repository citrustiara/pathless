/**
 * Route export.
 *
 * Elevation is written only when the terrain model actually has it; a GPX file
 * full of zero-metre points would be worse than one with no elevation at all.
 */
import type { OSMRoute } from "./osm-router";
import type { TerrainModel } from "./types";

export type ExportFormat = "gpx" | "geojson";

export const EXPORT_MIME_TYPES: Record<ExportFormat, string> = {
  gpx: "application/gpx+xml",
  geojson: "application/geo+json",
};

const escapeXml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const routeName = (route: OSMRoute): string => route.wayNames.length > 0
  ? `Pathless route via ${route.wayNames.slice(0, 2).join(" and ")}`
  : "Pathless route";

const elevationsFor = (
  route: OSMRoute,
  terrain: TerrainModel,
): Array<number | undefined> => route.coordinates.map((coordinate) =>
  terrain.hasElevation ? terrain.elevationAt(coordinate) : undefined);

export const routeToGpx = (route: OSMRoute, terrain: TerrainModel): string => {
  const elevations = elevationsFor(route, terrain);
  const points = route.coordinates.map((coordinate, index) => {
    const elevation = elevations[index];
    const body = elevation === undefined ? "" : `<ele>${elevation.toFixed(1)}</ele>`;
    return `      <trkpt lat="${coordinate.lat.toFixed(6)}" lon="${coordinate.lng.toFixed(6)}">${body}</trkpt>`;
  }).join("\n");
  const name = escapeXml(routeName(route));

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Pathless" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${name}</name></metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
};

export const routeToGeoJson = (route: OSMRoute, terrain: TerrainModel): string => {
  const elevations = elevationsFor(route, terrain);
  return `${JSON.stringify({
    type: "Feature",
    properties: {
      name: routeName(route),
      objective: route.objectiveLabel,
      distanceMeters: Math.round(route.distanceMeters),
      estimatedTimeMinutes: Math.round(route.estimatedTimeMinutes),
      ascentMeters: Math.round(route.ascentMeters),
      descentMeters: Math.round(route.descentMeters),
      mappedShare: Math.round((route.mappedDistanceMeters / Math.max(route.distanceMeters, 1)) * 100),
      elevationSource: terrain.hasElevation ? terrain.dataSource : "none",
    },
    geometry: {
      type: "LineString",
      coordinates: route.coordinates.map((coordinate, index) => {
        const elevation = elevations[index];
        return elevation === undefined
          ? [coordinate.lng, coordinate.lat]
          : [coordinate.lng, coordinate.lat, Number(elevation.toFixed(1))];
      }),
    },
  }, null, 2)}\n`;
};

export const exportRoute = (
  format: ExportFormat,
  route: OSMRoute,
  terrain: TerrainModel,
): string => (format === "gpx" ? routeToGpx(route, terrain) : routeToGeoJson(route, terrain));
