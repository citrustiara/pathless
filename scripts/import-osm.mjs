/**
 * Bakes the OpenStreetMap snapshot the router reads from an Overpass response.
 *
 * Fetch the response first, then run this over it:
 *
 *   curl -X POST -d @scripts/sopocka.overpass \
 *     https://overpass-api.de/api/interpreter -o /tmp/pathless-sopocka-map.json
 *   node scripts/import-osm.mjs
 *
 * The query lives in scripts/sopocka.overpass so the snapshot can actually be
 * reproduced; it used to exist only in whoever ran it last.
 */
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
/**
 * Barriers that actually stop someone on foot.
 *
 * Deliberately narrower than `barrier=*`: a guard rail or a bollard is there to
 * stop a vehicle and a walker steps past it, and a ditch is an obstacle but not
 * a closure. Those are all still imported and tagged, so the router can decide
 * later; only these are treated as something you cannot walk through.
 */
const blockingBarriers = new Set([
  "fence",
  "wall",
  "retaining_wall",
  "hedge",
  "city_wall",
]);
/** Nodes that mark a way through a barrier rather than a point on it. */
const barrierOpenings = new Set([
  "gate",
  "lift_gate",
  "swing_gate",
  "kissing_gate",
  "stile",
  "turnstile",
  "cattle_grid",
  "entrance",
]);

/**
 * Whether this barrier closes the line to someone on foot. An explicit foot or
 * access tag saying otherwise wins: a fence tagged `foot=yes` is a fence with a
 * way through it that someone has already recorded.
 */
const blocksOnFoot = (tags) => {
  if (!blockingBarriers.has(tags.barrier)) return false;
  const foot = (tags.foot ?? "").trim().toLowerCase();
  if (["yes", "designated", "permissive", "destination"].includes(foot)) return false;
  const access = (tags.access ?? "").trim().toLowerCase();
  return !["yes", "permissive", "destination"].includes(access);
};

/** Gate nodes, so a crossing can be allowed where OSM records a way through. */
const openings = source.elements.flatMap((element) => {
  if (element.type !== "node" || !barrierOpenings.has(element.tags?.barrier)) return [];
  const access = (element.tags.access ?? "").trim().toLowerCase();
  const locked = (element.tags.locked ?? "").trim().toLowerCase();
  // A gate nobody may use is not an opening.
  if (["private", "no"].includes(access) || locked === "yes") return [];
  return [[element.lat, element.lon]];
});

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
        : tags.barrier
          ? "barrier"
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
    blocksOnFoot: category === "barrier" ? blocksOnFoot(tags) : undefined,
    coordinates: element.geometry.map(({ lat, lon }) => [lat, lon]),
  }];
});

const outputData = {
  schemaVersion: 3,
  source: "OpenStreetMap",
  sourceUrl: "https://www.openstreetmap.org/",
  overpassUrl: "https://overpass-api.de/api/interpreter",
  license: "OpenStreetMap contributors · Open Database License (ODbL) 1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  processing: "Bounded Overpass extract filtered to routing ways, barriers, openings, and the tags used by Pathless",
  importedAt: new Date().toISOString(),
  osmTimestamp: source.osm3s?.timestamp_osm_base ?? null,
  bbox: {
    north: 54.4825,
    south: 54.4325,
    east: 18.5625,
    west: 18.4525,
  },
  features,
  barrierOpenings: openings,
};

await writeFile(output, `${JSON.stringify(outputData)}\n`);
console.log(
  `Imported ${features.length} OSM ways ` +
  `(${features.filter((feature) => feature.category === "barrier").length} barriers, ` +
  `${features.filter((feature) => feature.blocksOnFoot).length} of them closed on foot) ` +
  `and ${openings.length} openings into ${output}`,
);
