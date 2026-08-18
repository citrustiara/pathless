/**
 * Bakes a high-resolution digital terrain model for the Sopocka area from
 * GUGiK's public WCS (the Polish national mapping agency's LIDAR-derived
 * NMT). Run this once (and again whenever the working bbox changes) with:
 *
 *   node scripts/import-dtm.mjs
 *
 * Why baked rather than fetched live like the AWS elevation tiles: GUGiK's
 * WCS sends no Access-Control-Allow-Origin header, so a browser fetch()
 * against it is blocked outright — CORS doesn't apply to this script, only
 * to the app. Baking it here (mirroring import-osm.mjs) also means the app
 * never depends on a foreign government server being up, and loads the grid
 * instantly instead of waiting on a live multi-megabyte fetch.
 *
 * The service only accepts EPSG:2180 (Poland's CS92), so this fetches a
 * regular grid in that projection and resamples it onto the lat/lng grid
 * the rest of the app expects, via a forward-projection-per-cell pass
 * (proj4 is only needed here, at build time — never shipped to the browser).
 */
import { readFile, writeFile } from "node:fs/promises";
import proj4 from "proj4";

const OSM_SNAPSHOT_PATH = "src/data/sopocka-osm.json";
const OUTPUT_PATH = "src/data/sopocka-dtm.json";

const WCS_BASE = "https://mapy.geoportal.gov.pl/wss/service/PZGIK/NMT/GRID1/WCS/DigitalTerrainModel";
const COVERAGE = "DTM_PL-EVRF2007-NH";
/** Target ground sampling distance. Native LIDAR-derived NMT is 1 m; this stays comfortably below the ~10 km² per request the service tolerates before it gets unreliable. */
const TARGET_SPACING_METERS = 2;
/** Split the bbox into tiles no larger than this, so one flaky request only costs a retry of a few seconds, not the whole area. */
const MAX_TILE_METERS = 1100;
const FETCH_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 4;
const USER_AGENT = "pathless-dtm-importer/1.0 (+https://github.com/; hobby routing app, one-off bulk NMT fetch)";

const EPSG_2180 = "+proj=tmerc +lat_0=0 +lon_0=19 +k=0.9993 +x_0=500000 +y_0=-5300000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs";
proj4.defs("EPSG:2180", EPSG_2180);
const toPL1992 = (lng, lat) => proj4("EPSG:4326", "EPSG:2180", [lng, lat]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Arc/Info ASCII Grid: a handful of `key value` header lines, then ncols*nrows whitespace-separated numbers, north row first. */
function parseAsciiGrid(text) {
  const header = {};
  let bodyStart = 0;
  const lineRe = /^([A-Za-z_]+)\s+(\S+)[ \t]*\r?\n/;
  let rest = text;
  while (true) {
    const match = lineRe.exec(rest);
    if (!match) break;
    header[match[1].toLowerCase()] = match[2];
    bodyStart += match[0].length;
    rest = rest.slice(match[0].length);
  }
  const ncols = Number(header.ncols);
  const nrows = Number(header.nrows);
  const xllcorner = Number(header.xllcorner ?? header.xllcenter);
  const yllcorner = Number(header.yllcorner ?? header.yllcenter);
  const dx = Number(header.dx ?? header.cellsize);
  const dy = Number(header.dy ?? header.cellsize);
  const nodata = header.nodata_value !== undefined ? Number(header.nodata_value) : undefined;
  if (![ncols, nrows, xllcorner, yllcorner, dx, dy].every(Number.isFinite)) {
    throw new Error(`Unrecognised AAIGrid header: ${JSON.stringify(header)}`);
  }
  const data = new Float32Array(ncols * nrows);
  let index = 0;
  for (const token of rest.split(/\s+/)) {
    if (token === "") continue;
    data[index] = Number(token);
    index += 1;
  }
  if (index !== data.length) {
    throw new Error(`AAIGrid body had ${index} values, expected ${data.length}`);
  }
  return { ncols, nrows, xllcorner, yllcorner, dx, dy, nodata, data };
}

async function fetchTile(bbox, widthPx, heightPx, attempt = 1) {
  const params = new URLSearchParams({
    SERVICE: "WCS",
    VERSION: "1.0.0",
    REQUEST: "GetCoverage",
    COVERAGE: COVERAGE,
    FORMAT: "image/x-aaigrid",
    BBOX: bbox.join(","),
    CRS: "EPSG:2180",
    RESPONSE_CRS: "EPSG:2180",
    WIDTH: String(widthPx),
    HEIGHT: String(heightPx),
    INTERPOLATION: "bilinear",
  });
  const url = `${WCS_BASE}?${params.toString()}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (!/^ncols/i.test(text.trimStart())) {
      throw new Error(`Unexpected response (not an AAIGrid): ${text.slice(0, 200)}`);
    }
    return parseAsciiGrid(text);
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) throw error;
    const backoffMs = 1500 * attempt;
    console.warn(`  tile attempt ${attempt} failed (${error.message}), retrying in ${backoffMs}ms…`);
    await sleep(backoffMs);
    return fetchTile(bbox, widthPx, heightPx, attempt + 1);
  }
}

/** Split [minX,minY,maxX,maxY] into a grid of sub-boxes no larger than MAX_TILE_METERS on a side. */
function planTiles(minX, minY, maxX, maxY) {
  const cols = Math.max(1, Math.ceil((maxX - minX) / MAX_TILE_METERS));
  const rows = Math.max(1, Math.ceil((maxY - minY) / MAX_TILE_METERS));
  const tileWidth = (maxX - minX) / cols;
  const tileHeight = (maxY - minY) / rows;
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      tiles.push({
        row,
        col,
        bbox: [
          minX + col * tileWidth,
          minY + row * tileHeight,
          minX + (col + 1) * tileWidth,
          minY + (row + 1) * tileHeight,
        ],
      });
    }
  }
  return tiles;
}

async function main() {
  const snapshot = JSON.parse(await readFile(OSM_SNAPSHOT_PATH, "utf8"));
  const bounds = snapshot.bbox;
  console.log(`Fetching GUGiK NMT for bounds ${JSON.stringify(bounds)}`);

  const sw = toPL1992(bounds.west, bounds.south);
  const nw = toPL1992(bounds.west, bounds.north);
  const se = toPL1992(bounds.east, bounds.south);
  const ne = toPL1992(bounds.east, bounds.north);
  const minX = Math.min(sw[0], nw[0]);
  const maxX = Math.max(se[0], ne[0]);
  const minY = Math.min(sw[1], se[1]);
  const maxY = Math.max(nw[1], ne[1]);
  console.log(`EPSG:2180 extent: [${minX.toFixed(1)}, ${minY.toFixed(1)}] -> [${maxX.toFixed(1)}, ${maxY.toFixed(1)}] (${((maxX - minX) / 1000).toFixed(2)} x ${((maxY - minY) / 1000).toFixed(2)} km)`);

  const tiles = planTiles(minX, minY, maxX, maxY);
  console.log(`Fetching ${tiles.length} tile(s) at ~${TARGET_SPACING_METERS} m spacing…`);

  const fetched = [];
  for (const tile of tiles) {
    const [tMinX, tMinY, tMaxX, tMaxY] = tile.bbox;
    const width = Math.max(2, Math.round((tMaxX - tMinX) / TARGET_SPACING_METERS));
    const height = Math.max(2, Math.round((tMaxY - tMinY) / TARGET_SPACING_METERS));
    const started = Date.now();
    const grid = await fetchTile(tile.bbox, width, height);
    console.log(`  [${fetched.length + 1}/${tiles.length}] ${width}x${height} px in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    fetched.push(grid);
  }

  // Mosaic every tile's raw EPSG:2180 raster into one lookup: any (x, y) in
  // the combined extent bilinearly samples whichever tile covers it.
  const sampleMosaic = (x, y) => {
    for (const tile of fetched) {
      // xllcorner/yllcorner mark the grid's outer edge, not cell 0's centre,
      // so centre-indexed (row, col) needs the usual half-cell correction.
      const col = (x - tile.xllcorner) / tile.dx - 0.5;
      const row = tile.nrows - 0.5 - (y - tile.yllcorner) / tile.dy; // row 0 = north edge
      if (col < -0.5 || col > tile.ncols - 0.5 || row < -0.5 || row > tile.nrows - 0.5) continue;
      const c0 = Math.min(Math.max(Math.floor(col), 0), tile.ncols - 1);
      const r0 = Math.min(Math.max(Math.floor(row), 0), tile.nrows - 1);
      const c1 = Math.min(c0 + 1, tile.ncols - 1);
      const r1 = Math.min(r0 + 1, tile.nrows - 1);
      const fc = Math.min(Math.max(col - c0, 0), 1);
      const fr = Math.min(Math.max(row - r0, 0), 1);
      const at = (r, c) => tile.data[r * tile.ncols + c];
      return (
        at(r0, c0) * (1 - fc) * (1 - fr) +
        at(r0, c1) * fc * (1 - fr) +
        at(r1, c0) * (1 - fc) * fr +
        at(r1, c1) * fc * fr
      );
    }
    return null;
  };

  // Build the output grid regular in lat/lng — the shape every consumer in
  // this app already expects (see engine/elevation.ts's ElevationGrid).
  const metersPerDegLat = 111_320;
  const centreLat = (bounds.north + bounds.south) / 2;
  const metersPerDegLng = 111_320 * Math.cos((centreLat * Math.PI) / 180);
  const heightMeters = (bounds.north - bounds.south) * metersPerDegLat;
  const widthMeters = (bounds.east - bounds.west) * metersPerDegLng;
  const rows = Math.round(heightMeters / TARGET_SPACING_METERS) + 1;
  const columns = Math.round(widthMeters / TARGET_SPACING_METERS) + 1;
  console.log(`Resampling onto a ${rows} x ${columns} lat/lng grid…`);

  const latStep = (bounds.north - bounds.south) / (rows - 1);
  const lngStep = (bounds.east - bounds.west) / (columns - 1);
  let missing = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const decimetres = new Int16Array(rows * columns);
  for (let row = 0; row < rows; row += 1) {
    const lat = bounds.north - row * latStep;
    for (let column = 0; column < columns; column += 1) {
      const lng = bounds.west + column * lngStep;
      const [x, y] = toPL1992(lng, lat);
      const elevation = sampleMosaic(x, y);
      if (elevation === null) {
        missing += 1;
        decimetres[row * columns + column] = -32768; // sentinel, filled in below
        continue;
      }
      if (elevation < min) min = elevation;
      if (elevation > max) max = elevation;
      decimetres[row * columns + column] = Math.round(elevation * 10);
    }
  }
  if (missing > 0) {
    console.warn(`${missing} of ${rows * columns} cells fell outside every fetched tile; filling with the nearest valid value.`);
    // A cell can only miss if it lands in the sliver between tiles lost to
    // floating point rounding at a shared edge; nearest-neighbour fill is
    // exact enough for that.
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const index = row * columns + column;
        if (decimetres[index] !== -32768) continue;
        for (let radius = 1; radius < Math.max(rows, columns); radius += 1) {
          let found;
          for (let dr = -radius; dr <= radius && found === undefined; dr += 1) {
            for (let dc = -radius; dc <= radius; dc += 1) {
              const r = row + dr, c = column + dc;
              if (r < 0 || r >= rows || c < 0 || c >= columns) continue;
              const value = decimetres[r * columns + c];
              if (value !== -32768) { found = value; break; }
            }
          }
          if (found !== undefined) { decimetres[index] = found; break; }
        }
      }
    }
  }

  const base64 = Buffer.from(decimetres.buffer, decimetres.byteOffset, decimetres.byteLength).toString("base64");
  const output = {
    schemaVersion: 1,
    source: "GUGiK NMT (Numeryczny Model Terenu), PZGiK national LIDAR survey",
    sourceUrl: "https://www.geoportal.gov.pl/en/data/digital-elevation-model-dem/",
    coverage: COVERAGE,
    license: "Publicly available without restriction (GUGiK / PZGiK open data)",
    importedAt: new Date().toISOString(),
    bounds,
    rows,
    columns,
    spacingMeters: Math.min(heightMeters / (rows - 1), widthMeters / (columns - 1)),
    /** Decimetres above sea level, row-major, north row first, west column first. */
    unit: "decimetres",
    minElevationMeters: Math.round(min * 10) / 10,
    maxElevationMeters: Math.round(max * 10) / 10,
    dataBase64: base64,
  };
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output)}\n`);
  console.log(`Wrote ${rows * columns} points (${(base64.length / 1_000_000).toFixed(1)} MB base64) to ${OUTPUT_PATH}`);
  console.log(`Elevation range: ${output.minElevationMeters} m – ${output.maxElevationMeters} m, spacing ~${output.spacingMeters.toFixed(2)} m`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
