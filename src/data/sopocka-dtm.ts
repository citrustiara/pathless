import { createElevationGrid, type ElevationGrid } from "../engine/elevation";

/** Decode a little-endian Int16Array packed as base64 — see scripts/import-dtm.mjs. */
const decodeDecimetres = (base64: string): Int16Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Int16Array(bytes.buffer);
};

let cached: Promise<ElevationGrid> | undefined;

/**
 * The Sopocka area's real terrain, baked from GUGiK's national LIDAR survey
 * (see scripts/import-dtm.mjs for why this is baked rather than fetched
 * live). The snapshot is ~6.6 MB, so it's a dynamic import: it loads as its
 * own chunk instead of bloating the main bundle every visitor has to parse
 * before the app can render at all, and only fetches once something
 * actually asks for it.
 */
export const loadSopockaDtmGrid = (): Promise<ElevationGrid> => {
  if (!cached) {
    cached = import("./sopocka-dtm.json").then((module) => {
      const snapshot = module.default;
      if (snapshot.schemaVersion !== 1) {
        throw new Error("Sopocka DTM snapshot schema is stale; run scripts/import-dtm.mjs again.");
      }
      const decimetres = decodeDecimetres(snapshot.dataBase64);
      const meters = new Float32Array(decimetres.length);
      for (let index = 0; index < decimetres.length; index += 1) meters[index] = decimetres[index] / 10;
      const attribution = `${snapshot.source}, ~${snapshot.spacingMeters.toFixed(1)} m grid`;
      return createElevationGrid(
        snapshot.bounds,
        snapshot.rows,
        snapshot.columns,
        meters,
        attribution,
        snapshot.sourceUrl,
      );
    });
  }
  return cached;
};
