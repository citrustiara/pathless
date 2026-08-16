import { describe, expect, it } from "vitest";
import {
  createSyntheticTerrainModel,
  localMetersToCoordinate,
  normalizeRoutingPreferences,
  planRoute,
  type Coordinate,
} from "./index";

const point = (xMeters: number, yMeters: number): Coordinate =>
  localMetersToCoordinate({ x: xMeters, y: yMeters });

describe("synthetic terrain model", () => {
  it("is deterministic and centred on the prototype location", () => {
    const first = createSyntheticTerrainModel();
    const second = createSyntheticTerrainModel();
    const centre = first.cellAtCoordinate({ lat: 54.458403, lng: 18.509192 });

    expect(first.center).toEqual({ lat: 54.458403, lng: 18.509192 });
    expect(first.cells).toEqual(second.cells);
    expect(centre.coordinate.lat).toBeCloseTo(54.458403, 5);
    expect(centre.coordinate.lng).toBeCloseTo(18.509192, 5);
    expect(first.cells.some((cell) => cell.mappedPath)).toBe(true);
    expect(first.cells.some((cell) => cell.landCover === "water")).toBe(true);
  });
});

describe("terrain router", () => {
  it("routes to a selected destination with objective-diverse alternatives", () => {
    const result = planRoute({
      mode: "selected-destination",
      origin: point(-1_100, -700),
      destination: point(1_100, 650),
      profile: "walking",
      alternatives: 3,
    });

    expect(result.errors).toEqual([]);
    expect(result.routes.length).toBe(3);
    expect(result.primaryRoute?.metrics.distanceMeters).toBeGreaterThan(0);
    expect(result.primaryRoute?.metrics.ascentMeters).toBeGreaterThanOrEqual(0);
    expect(result.primaryRoute?.metrics.maxSlopeDegrees).toBeGreaterThan(0);
    expect(result.primaryRoute?.metrics.estimatedTimeMinutes).toBeGreaterThan(0);
    expect(result.primaryRoute?.metrics.confidence).toBeGreaterThanOrEqual(0);
    expect(result.primaryRoute?.metrics.confidence).toBeLessThanOrEqual(1);
    expect(result.routes.map((route) => route.objective)).toEqual([
      "balanced",
      "fastest",
      "gentle",
    ]);

    const routeSignatures = result.routes.map((route) =>
      route.coordinates.map((coordinate) => `${coordinate.lat},${coordinate.lng}`).join(";"),
    );
    expect(new Set(routeSignatures).size).toBeGreaterThan(1);
  });

  it("finds the nearest mapped path without a destination", () => {
    const result = planRoute({
      mode: "nearest-mapped-path",
      origin: point(0, 0),
      profile: "mtb",
      alternatives: 2,
    });

    expect(result.errors).toEqual([]);
    expect(result.snappedTargets).toHaveLength(1);
    expect(result.primaryRoute).toBeDefined();
    expect(result.primaryRoute?.coordinates.length).toBeGreaterThan(0);
    expect(
      createSyntheticTerrainModel()
        .cellAtCoordinate(result.snappedTargets[0])
        .mappedPath,
    ).toBe(true);
  });

  it("joins design-route legs in waypoint order", () => {
    const waypoints = [point(-700, -450), point(650, 500)];
    const result = planRoute({
      mode: "design-route",
      origin: point(-1_150, -800),
      waypoints,
      profile: "walking",
      preferences: { pathPreference: 0.8, waterAvoidance: 1 },
      alternatives: 1,
    });

    expect(result.errors).toEqual([]);
    expect(result.primaryRoute?.snappedWaypoints).toHaveLength(2);
    expect(result.primaryRoute?.coordinates).toContainEqual(
      result.primaryRoute?.snappedWaypoints[0],
    );
    expect(result.primaryRoute?.coordinates).toContainEqual(
      result.primaryRoute?.snappedWaypoints[1],
    );
    expect(result.primaryRoute?.metrics.distanceMeters).toBeGreaterThan(
      1_000,
    );
  });

  it("normalizes slider input to safe preference ranges", () => {
    expect(
      normalizeRoutingPreferences({
        slopeTolerance: 999,
        ascentPreference: -999,
        ascentBudget: -20,
        roughness: Number.NaN,
        pathPreference: 2,
        waterAvoidance: -1,
      }),
    ).toEqual({
      slopeTolerance: 45,
      ascentPreference: -1,
      ascentBudget: 0,
      roughness: 0.45,
      pathPreference: 1,
      waterAvoidance: 0,
    });
  });
});

