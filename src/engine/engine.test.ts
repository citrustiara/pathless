import { describe, expect, it } from "vitest";
import {
  buildContours,
  createElevationGrid,
  createFlatTerrainModel,
  createTerrainModel,
  distanceBetweenCoordinates,
  routeToGeoJson,
  routeToGpx,
  osmGraphStats,
  planOSMRoute,
  suggestContourInterval,
  type Coordinate,
  type GeoBounds,
  type OSMRoutingRequest,
} from "./index";

const BOUNDS: GeoBounds = { north: 54.47, south: 54.445, east: 18.535, west: 18.48 };

/**
 * A clean north-facing ramp: 0 m on the northern edge, `reliefMeters` on the
 * southern. The working area is ~2783 m north to south, so the fall line runs
 * at `reliefMeters / 2783`; a 100 m ramp is 3.6%, a 1000 m ramp 35.9%.
 */
const rampGrid = (reliefMeters = 100, rows = 21, columns = 21) => {
  const data = new Float32Array(rows * columns);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      data[row * columns + column] = (row / (rows - 1)) * reliefMeters;
    }
  }
  return createElevationGrid(BOUNDS, rows, columns, data);
};

/** Compass-free heading of a segment, in degrees, measured off due east. */
const headingDegrees = (from: Coordinate, to: Coordinate): number =>
  (Math.atan2(to.lat - from.lat, (to.lng - from.lng) * Math.cos((54.4575 * Math.PI) / 180)) * 180) /
  Math.PI;

/** How far a heading sits from the nearest multiple of 45 degrees. */
const offGridDegrees = (heading: number): number =>
  Math.abs((((heading % 45) + 45 + 22.5) % 45) - 22.5);

const baseRequest: OSMRoutingRequest = {
  mode: "destination",
  origin: { lat: 54.4580849, lng: 18.5120994 },
  destination: { lat: 54.4605396, lng: 18.5086773 },
  waypoints: [],
  profile: "hiker",
  maxGradePercent: 45,
  offTrailAversion: 2,
  maxOffTrailMeters: 400,
  allowStreetCrossing: true,
  allowStreetWalking: false,
  avoidWater: false,
  alternatives: 1,
};

const terrainFor = (grid = rampGrid()) =>
  createTerrainModel({ bounds: BOUNDS, elevation: grid, cellSizeMeters: 25 });

describe("elevation grid", () => {
  it("interpolates between samples instead of snapping to the nearest one", () => {
    const grid = rampGrid();
    expect(grid.sample(BOUNDS.north, BOUNDS.west)).toBeCloseTo(0, 4);
    expect(grid.sample(BOUNDS.south, BOUNDS.east)).toBeCloseTo(100, 4);
    expect(grid.sample((BOUNDS.north + BOUNDS.south) / 2, BOUNDS.west)).toBeCloseTo(50, 2);
  });

  it("clamps samples taken outside the grid", () => {
    const grid = rampGrid();
    expect(grid.sample(BOUNDS.north + 1, BOUNDS.west - 1)).toBeCloseTo(0, 4);
    expect(grid.sample(BOUNDS.south - 1, BOUNDS.east + 1)).toBeCloseTo(100, 4);
  });
});

describe("contours", () => {
  it("draws one line per interval across a ramp, at the right heights", () => {
    const grid = rampGrid();
    const contours = buildContours(grid, 10);
    const elevations = [...new Set(contours.map((line) => line.elevation))].sort((a, b) => a - b);

    // Every level is a clean multiple of the interval, and the levels between
    // the extremes are all present.
    expect(elevations.every((value) => value % 10 === 0)).toBe(true);
    expect(elevations).toEqual(expect.arrayContaining([10, 20, 30, 40, 50, 60, 70, 80, 90]));
    // A north-facing ramp has exactly one contour per level, running east-west.
    expect(contours.filter((line) => line.elevation === 50)).toHaveLength(1);
    const fifty = contours.find((line) => line.elevation === 50);
    const latitudes = fifty?.points.map(([lat]) => lat) ?? [];
    expect(Math.max(...latitudes) - Math.min(...latitudes)).toBeLessThan(1e-6);
  });

  it("marks every fifth interval as an index contour", () => {
    const indexElevations = buildContours(rampGrid(), 10)
      .filter((line) => line.index)
      .map((line) => line.elevation);
    expect(indexElevations.every((value) => value % 50 === 0)).toBe(true);
    expect(indexElevations).toContain(50);
    expect(indexElevations).not.toContain(40);
  });

  it("scales the interval to the local relief", () => {
    const gentle = createElevationGrid(BOUNDS, 4, 4, new Float32Array([
      0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6,
    ]));
    expect(suggestContourInterval(gentle)).toBeLessThanOrEqual(2);
    expect(suggestContourInterval(rampGrid())).toBeGreaterThanOrEqual(5);
  });

  it("returns nothing for a nonsense interval", () => {
    expect(buildContours(rampGrid(), 0)).toEqual([]);
    expect(buildContours(rampGrid(), Number.NaN)).toEqual([]);
  });
});

describe("terrain model", () => {
  it("derives slope from the real elevation gradient", () => {
    const terrain = terrainFor();
    const heightMeters = (BOUNDS.north - BOUNDS.south) * 111_132;
    const expectedDegrees = (Math.atan(100 / heightMeters) * 180) / Math.PI;
    const middle = terrain.cellAtCoordinate({
      lat: (BOUNDS.north + BOUNDS.south) / 2,
      lng: (BOUNDS.east + BOUNDS.west) / 2,
    });

    expect(terrain.hasElevation).toBe(true);
    expect(middle.slopeDegrees).toBeCloseTo(expectedDegrees, 1);
    // A perfectly smooth ramp is not rugged, even though it is steep.
    expect(middle.ruggednessMeters).toBeLessThan(1.5);
  });

  it("reports flat ground rather than inventing relief when tiles are missing", () => {
    const terrain = createFlatTerrainModel(BOUNDS);
    expect(terrain.hasElevation).toBe(false);
    expect(terrain.dataSource).toBe("flat");
    expect(terrain.cells.every((cell) => cell.elevationMeters === 0)).toBe(true);
    expect(terrain.cells.every((cell) => cell.slopeDegrees === 0)).toBe(true);
  });

  it("marks water risk only near a mapped watercourse", () => {
    const stream: Coordinate[] = [
      { lat: 54.4575, lng: 18.5 },
      { lat: 54.4575, lng: 18.515 },
    ];
    const terrain = createTerrainModel({
      bounds: BOUNDS,
      elevation: rampGrid(),
      cellSizeMeters: 25,
      waterways: [stream],
    });

    expect(terrain.cellAtCoordinate({ lat: 54.4575, lng: 18.507 }).waterRisk).toBeGreaterThan(0.3);
    expect(terrain.cellAtCoordinate({ lat: 54.4655, lng: 18.507 }).waterRisk).toBe(0);
  });
});

describe("OSM router", () => {
  it("imports mapped crossing evidence from the snapshot", () => {
    expect(osmGraphStats.nodes).toBeGreaterThan(0);
    expect(osmGraphStats.mappedCrossings).toBeGreaterThan(0);
  });

  it("keeps off the carriageway unless street walking is allowed", () => {
    const terrain = terrainFor();
    const onFoot = planOSMRoute(baseRequest, terrain);
    expect(onFoot.errors).toEqual([]);
    expect(onFoot.routes[0]?.segments.some((segment) => segment.highway === "secondary")).toBe(false);

    const onStreets = planOSMRoute({ ...baseRequest, allowStreetWalking: true }, terrain);
    expect(onStreets.routes[0]?.segments.some((segment) => segment.highway === "secondary")).toBe(true);
  });

  it("refuses a route rather than exceeding the grade limit", () => {
    // A 36% fall line with a 4% ceiling: no traverse shallow enough to obey it
    // fits inside the off-trail budget, so refusing is the only honest answer.
    const result = planOSMRoute(
      { ...baseRequest, maxGradePercent: 4 },
      terrainFor(rampGrid(1000)),
    );
    expect(result.routes).toEqual([]);
    expect(result.errors[0]).toContain("No route satisfies");
  });

  it("traverses a slope rather than refusing a cap the fall line cannot meet", () => {
    // The ramp falls at 14.4%, so nothing running straight down it obeys an 8%
    // ceiling. Angling across the contours does, and the router is expected to
    // find that angle rather than give up -- with only the eight 45-degree grid
    // headings it could not, because the shallowest of them off the contour is
    // far too steep.
    const result = planOSMRoute(
      { ...baseRequest, maxGradePercent: 8 },
      terrainFor(rampGrid(400)),
    );
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes[0].maxGrade).toBeLessThanOrEqual(0.085);
    expect(result.routes[0].ascentMeters + result.routes[0].descentMeters).toBeGreaterThan(0);
  });

  it("draws off-trail lines on headings the cell grid does not have", () => {
    const result = planOSMRoute(
      { ...baseRequest, maxGradePercent: 8, maxOffTrailMeters: 400 },
      terrainFor(rampGrid(400)),
    );
    const offTrail = result.routes[0].segments
      .filter((segment) => !segment.mappedPath && segment.distanceMeters > 1);
    expect(offTrail.length).toBeGreaterThan(4);
    // The first and last hop join real coordinates to cell centres, so they sit
    // off the grid whatever the move set is. Only the cell-to-cell hops between
    // them carry the staircase signature: every heading a multiple of 45.
    const interior = offTrail.slice(1, -1);
    const headings = interior.map((segment) => headingDegrees(segment.from, segment.to));
    const offGrid = headings.filter((heading) => offGridDegrees(heading) > 2).length;
    expect(offGrid / headings.length).toBeGreaterThan(0.25);
  });

  it("never exceeds the grade limit on a route it does return", () => {
    const result = planOSMRoute({ ...baseRequest, maxGradePercent: 25 }, terrainFor(rampGrid(400)));
    expect(result.routes.length).toBeGreaterThan(0);
    expect(result.routes[0].maxGrade).toBeLessThanOrEqual(0.255);
  });

  it("honours the cap on any single off-trail stretch", () => {
    const terrain = terrainFor();
    const result = planOSMRoute({ ...baseRequest, maxOffTrailMeters: 60 }, terrain);
    for (const route of result.routes) {
      expect(route.longestOffTrailMeters).toBeLessThanOrEqual(61);
    }
  });

  it("treats crossing a street as an option the caller controls", () => {
    const terrain = terrainFor();
    const strict = planOSMRoute({ ...baseRequest, allowStreetCrossing: false }, terrain);
    const relaxed = planOSMRoute({ ...baseRequest, allowStreetCrossing: true }, terrain);

    expect(relaxed.routes.length).toBeGreaterThan(0);
    // Allowing crossings can only ever open up more of the network.
    if (strict.routes.length > 0) {
      expect(relaxed.routes[0].estimatedTimeMinutes)
        .toBeLessThanOrEqual(strict.routes[0].estimatedTimeMinutes + 0.001);
    }
  });

  it("returns alternatives that actually differ from each other", () => {
    const result = planOSMRoute(
      {
        ...baseRequest,
        origin: { lat: 54.447, lng: 18.49 },
        destination: { lat: 54.468, lng: 18.53 },
        alternatives: 3,
      },
      terrainFor(),
    );

    expect(result.routes.length).toBeGreaterThan(1);
    expect(new Set(result.routes.map((route) => route.objective)).size)
      .toBe(result.routes.length);
    const geometries = result.routes.map((route) =>
      route.coordinates.map((point) => `${point.lat},${point.lng}`).join(";"));
    expect(new Set(geometries).size).toBe(result.routes.length);
  });

  it("reports climb, time, and an elevation profile that agree with each other", () => {
    const route = planOSMRoute(baseRequest, terrainFor()).routes[0];
    expect(route).toBeDefined();
    expect(route.distanceMeters).toBeGreaterThan(0);
    expect(route.estimatedTimeMinutes).toBeGreaterThan(0);
    expect(route.samples.length).toBe(route.segments.length + 1);
    expect(route.samples[0].distanceMeters).toBe(0);
    expect(route.samples[route.samples.length - 1].distanceMeters)
      .toBeCloseTo(route.distanceMeters, 6);
    expect(route.ascentMeters - route.descentMeters).toBeCloseTo(
      route.samples[route.samples.length - 1].elevationMeters - route.samples[0].elevationMeters,
      0,
    );
    const surfaceTotal = route.surfaceBreakdown
      .reduce((total, entry) => total + entry.distanceMeters, 0);
    expect(surfaceTotal).toBeCloseTo(route.distanceMeters, 6);
  });

  it("says so instead of guessing when elevation is unavailable", () => {
    const result = planOSMRoute(baseRequest, createFlatTerrainModel(BOUNDS));
    expect(result.routes[0]?.ascentMeters).toBe(0);
    expect(result.warnings.join(" ")).toContain("Elevation data is unavailable");
  });

  it("costs more time uphill than downhill along the same ground", () => {
    // The ramp rises towards the south, so swapping the endpoints swaps the
    // direction of travel without changing the terrain underneath.
    const terrain = terrainFor();
    const northbound = planOSMRoute(baseRequest, terrain).routes[0];
    const southbound = planOSMRoute(
      { ...baseRequest, origin: baseRequest.destination as Coordinate, destination: baseRequest.origin },
      terrain,
    ).routes[0];

    expect(northbound.ascentMeters).toBeLessThan(northbound.descentMeters);
    expect(southbound.ascentMeters).toBeGreaterThan(southbound.descentMeters);
    expect(southbound.estimatedTimeMinutes / southbound.distanceMeters)
      .toBeGreaterThan(northbound.estimatedTimeMinutes / northbound.distanceMeters);
  });

  it("finds the nearest mapped path when no destination is given", () => {
    const result = planOSMRoute({ ...baseRequest, mode: "nearest", destination: undefined }, terrainFor());
    expect(result.errors).toEqual([]);
    const route = result.routes[0];
    expect(route.snappedDestination).toBeDefined();
    expect(distanceBetweenCoordinates(baseRequest.origin, route.snappedDestination as Coordinate))
      .toBeLessThan(600);
  });

  it("visits design-mode waypoints in order", () => {
    const waypoint = { lat: 54.4596, lng: 18.5142 };
    const result = planOSMRoute(
      { ...baseRequest, mode: "design", waypoints: [waypoint] },
      terrainFor(),
    );
    expect(result.errors).toEqual([]);
    const nearest = Math.min(
      ...result.routes[0].coordinates.map((point) => distanceBetweenCoordinates(point, waypoint)),
    );
    expect(nearest).toBeLessThan(30);
  });
});

describe("export", () => {
  const routeFor = (terrain = terrainFor()) => {
    const route = planOSMRoute(baseRequest, terrain).routes[0];
    expect(route).toBeDefined();
    return route;
  };

  it("writes every point with elevation into the GPX track", () => {
    const terrain = terrainFor();
    const route = routeFor(terrain);
    const gpx = routeToGpx(route, terrain);

    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(gpx).toContain('<gpx version="1.1" creator="Pathless"');
    expect((gpx.match(/<trkpt /g) ?? []).length).toBe(route.coordinates.length);
    expect((gpx.match(/<ele>/g) ?? []).length).toBe(route.coordinates.length);
    expect(gpx.trimEnd().endsWith("</gpx>")).toBe(true);
  });

  it("leaves elevation out entirely rather than writing zeroes", () => {
    const terrain = createFlatTerrainModel(BOUNDS);
    const route = routeFor(terrain);

    expect(routeToGpx(route, terrain)).not.toContain("<ele>");
    const geojson = JSON.parse(routeToGeoJson(route, terrain));
    expect(geojson.geometry.coordinates.every((point: number[]) => point.length === 2)).toBe(true);
    expect(geojson.properties.elevationSource).toBe("none");
  });

  it("writes GeoJSON in longitude, latitude, elevation order", () => {
    const terrain = terrainFor();
    const route = routeFor(terrain);
    const geojson = JSON.parse(routeToGeoJson(route, terrain));

    expect(geojson.type).toBe("Feature");
    expect(geojson.geometry.type).toBe("LineString");
    expect(geojson.geometry.coordinates).toHaveLength(route.coordinates.length);
    const [lng, lat, ele] = geojson.geometry.coordinates[0];
    expect(lng).toBeCloseTo(route.coordinates[0].lng, 6);
    expect(lat).toBeCloseTo(route.coordinates[0].lat, 6);
    expect(ele).toBeCloseTo(terrain.elevationAt(route.coordinates[0]), 0);
    expect(geojson.properties.distanceMeters).toBe(Math.round(route.distanceMeters));
  });

  it("escapes way names taken from OSM into the GPX name", () => {
    const terrain = terrainFor();
    const route = { ...routeFor(terrain), wayNames: ['Droga "A" & B'] };
    expect(routeToGpx(route, terrain)).toContain("Droga &quot;A&quot; &amp; B");
  });
});
