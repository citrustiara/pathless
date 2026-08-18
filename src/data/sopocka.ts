import snapshot from "./sopocka-osm.json";

if (snapshot.schemaVersion !== 3) {
  throw new Error("Sopocka OSM snapshot schema is stale; run scripts/import-osm.mjs again.");
}

export type OSMFeatureCategory = "path" | "road" | "water" | "barrier";

export type OSMFeature = {
  id: string;
  category: OSMFeatureCategory;
  highway?: string;
  name?: string;
  surface?: string;
  access?: string;
  foot?: string;
  sidewalk?: string;
  sidewalkLeft?: string;
  sidewalkRight?: string;
  crossing?: string;
  bridge?: string;
  tunnel?: string;
  barrier?: string;
  incline?: string;
  width?: string;
  oneway?: string;
  bicycle?: string;
  motorVehicle?: string;
  layer?: string;
  tracktype?: string;
  trailVisibility?: string;
  waterway?: string;
  /**
   * Set only on barriers: whether this one closes the line to someone on foot.
   * A guard rail or bollard stops a vehicle and not a walker, so those are
   * imported and tagged but do not block.
   */
  blocksOnFoot?: boolean;
  coordinates: Array<[number, number]>;
};

export const SOPOCKA_OSM_FEATURES = snapshot.features as OSMFeature[];
/** Ways someone can actually travel along. Water and barriers are evidence, not routes. */
export const SOPOCKA_OSM_WAYS = SOPOCKA_OSM_FEATURES
  .filter((feature) => feature.category !== "water" && feature.category !== "barrier");

/** Mapped walls, fences and hedges that close the line on foot. */
export const SOPOCKA_BARRIERS = SOPOCKA_OSM_FEATURES
  .filter((feature) => feature.category === "barrier" && feature.blocksOnFoot);

/**
 * Gates and stiles: the places OSM records a way through a barrier. Ones tagged
 * private or locked are left out during import, so everything here is usable.
 */
export const SOPOCKA_BARRIER_OPENINGS: Array<{ lat: number; lng: number }> =
  (snapshot.barrierOpenings as Array<[number, number]>).map(([lat, lng]) => ({ lat, lng }));
export const SOPOCKA_OSM_PATHS = SOPOCKA_OSM_FEATURES.filter((feature) => feature.category === "path" || feature.highway === "track");
export const SOPOCKA_OSM_METADATA = {
  schemaVersion: snapshot.schemaVersion,
  source: snapshot.source,
  sourceUrl: snapshot.sourceUrl,
  overpassUrl: snapshot.overpassUrl,
  license: snapshot.license,
  importedAt: snapshot.importedAt,
  osmTimestamp: snapshot.osmTimestamp,
  bbox: snapshot.bbox,
  featureCount: SOPOCKA_OSM_FEATURES.length,
  pathCount: SOPOCKA_OSM_PATHS.length,
  barrierCount: SOPOCKA_BARRIERS.length,
  barrierOpeningCount: SOPOCKA_BARRIER_OPENINGS.length,
} as const;

/** Mapped watercourses as coordinate polylines, the only water evidence used. */
export const SOPOCKA_WATERWAYS: Array<Array<{ lat: number; lng: number }>> = SOPOCKA_OSM_FEATURES
  .filter((feature) => feature.category === "water")
  .map((feature) => feature.coordinates.map(([lat, lng]) => ({ lat, lng })));

/** Bounding box of the imported snapshot, used for the map and terrain grid. */
export const SOPOCKA_BOUNDS = snapshot.bbox as {
  north: number;
  south: number;
  east: number;
  west: number;
};
