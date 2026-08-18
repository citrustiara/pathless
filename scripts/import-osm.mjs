import { readFile, writeFile } from "node:fs/promises";

const input = process.argv[2] ?? "/tmp/pathless-sopocka-map.json";
const output = process.argv[3] ?? "src/data/sopocka-osm.json";

const source = JSON.parse(await readFile(input, "utf8"));
const supportedRoads = new Set([
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "service",
  "track",
]);
const supportedPaths = new Set([
  "path",
  "footway",
  "cycleway",
  "bridleway",
  "pedestrian",
  "steps",
]);

const features = source.elements.flatMap((element) => {
  if (element.type !== "way" || !Array.isArray(element.geometry) || element.geometry.length < 2) {
    return [];
  }

  const tags = element.tags ?? {};
  const highway = tags.highway;
  const category = supportedPaths.has(highway)
    ? "path"
    : supportedRoads.has(highway)
      ? "road"
      : tags.waterway || tags.natural === "water"
        ? "water"
        : null;
  if (!category) return [];

  return [{
    id: `way/${element.id}`,
    category,
    highway,
    name: tags.name,
    surface: tags.surface,
    access: tags.access,
    foot: tags.foot,
    sidewalk: tags.sidewalk,
    sidewalkLeft: tags["sidewalk:left"],
    sidewalkRight: tags["sidewalk:right"],
    crossing: tags.crossing,
    bridge: tags.bridge,
    tunnel: tags.tunnel,
    barrier: tags.barrier,
    incline: tags.incline,
    width: tags.width,
    oneway: tags.oneway,
    bicycle: tags.bicycle,
    motorVehicle: tags.motor_vehicle,
    layer: tags.layer,
    tracktype: tags.tracktype,
    trailVisibility: tags.trail_visibility,
    waterway: tags.waterway,
    coordinates: element.geometry.map(({ lat, lon }) => [lat, lon]),
  }];
});

const outputData = {
  schemaVersion: 2,
  source: "OpenStreetMap",
  sourceUrl: "https://www.openstreetmap.org/",
  overpassUrl: "https://overpass-api.de/api/interpreter",
  license: "OpenStreetMap contributors · ODbL",
  importedAt: new Date().toISOString(),
  osmTimestamp: source.osm3s?.timestamp_osm_base ?? null,
  bbox: {
    north: 54.470,
    south: 54.445,
    east: 18.535,
    west: 18.480,
  },
  features,
};

await writeFile(output, `${JSON.stringify(outputData)}\n`);
console.log(`Imported ${features.length} OSM ways into ${output}`);
