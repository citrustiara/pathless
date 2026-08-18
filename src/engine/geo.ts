/**
 * Small-area geodesy helpers.
 *
 * Everything here assumes a working area of a few kilometres, where an
 * equirectangular approximation is both cheaper and more numerically stable
 * than spherical trigonometry.
 */
import type { Coordinate, GeoBounds } from "./types";

export const METERS_PER_DEGREE_LATITUDE = 111_132;

export const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

export const metersPerDegreeLongitude = (latitude: number): number =>
  METERS_PER_DEGREE_LATITUDE * Math.cos(toRadians(latitude));

/** Planar distance in metres between two nearby WGS84 coordinates. */
export const distanceBetweenCoordinates = (a: Coordinate, b: Coordinate): number =>
  Math.hypot(
    (b.lng - a.lng) * metersPerDegreeLongitude((a.lat + b.lat) / 2),
    (b.lat - a.lat) * METERS_PER_DEGREE_LATITUDE,
  );

export const interpolateCoordinate = (
  from: Coordinate,
  to: Coordinate,
  fraction: number,
): Coordinate => ({
  lat: from.lat + (to.lat - from.lat) * fraction,
  lng: from.lng + (to.lng - from.lng) * fraction,
});

export const boundsCenter = (bounds: GeoBounds): Coordinate => ({
  lat: (bounds.north + bounds.south) / 2,
  lng: (bounds.east + bounds.west) / 2,
});

export const boundsContain = (bounds: GeoBounds, coordinate: Coordinate): boolean =>
  coordinate.lat >= bounds.south &&
  coordinate.lat <= bounds.north &&
  coordinate.lng >= bounds.west &&
  coordinate.lng <= bounds.east;

/** Grow a bounding box by a margin expressed in metres. */
export const padBounds = (bounds: GeoBounds, marginMeters: number): GeoBounds => {
  const latitudePad = marginMeters / METERS_PER_DEGREE_LATITUDE;
  const longitudePad = marginMeters / metersPerDegreeLongitude(boundsCenter(bounds).lat);
  return {
    north: bounds.north + latitudePad,
    south: bounds.south - latitudePad,
    east: bounds.east + longitudePad,
    west: bounds.west - longitudePad,
  };
};

type PlanarPoint = { x: number; y: number };

/** Project to local metres using a shared latitude reference. */
export const toPlanar = (coordinate: Coordinate, latitudeReference: number): PlanarPoint => ({
  x: coordinate.lng * metersPerDegreeLongitude(latitudeReference),
  y: coordinate.lat * METERS_PER_DEGREE_LATITUDE,
});

export const pointDistanceToSegment = (
  point: Coordinate,
  from: Coordinate,
  to: Coordinate,
): number => {
  const latitude = (point.lat + from.lat + to.lat) / 3;
  const p = toPlanar(point, latitude);
  const a = toPlanar(from, latitude);
  const b = toPlanar(to, latitude);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const projection = lengthSquared === 0
    ? 0
    : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(p.x - (a.x + projection * dx), p.y - (a.y + projection * dy));
};

const cross = (a: PlanarPoint, b: PlanarPoint, c: PlanarPoint): number =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

const pointOnSegment = (point: Coordinate, from: Coordinate, to: Coordinate): boolean => {
  const latitude = (point.lat + from.lat + to.lat) / 3;
  const p = toPlanar(point, latitude);
  const a = toPlanar(from, latitude);
  const b = toPlanar(to, latitude);
  return Math.abs(cross(a, b, p)) < 0.02 &&
    p.x >= Math.min(a.x, b.x) - 0.1 && p.x <= Math.max(a.x, b.x) + 0.1 &&
    p.y >= Math.min(a.y, b.y) - 0.1 && p.y <= Math.max(a.y, b.y) + 0.1;
};

/** Intersection of two short segments, or `undefined` when they do not meet. */
export const segmentIntersection = (
  firstFrom: Coordinate,
  firstTo: Coordinate,
  secondFrom: Coordinate,
  secondTo: Coordinate,
): Coordinate | undefined => {
  const latitude = (firstFrom.lat + firstTo.lat + secondFrom.lat + secondTo.lat) / 4;
  const a = toPlanar(firstFrom, latitude);
  const b = toPlanar(firstTo, latitude);
  const c = toPlanar(secondFrom, latitude);
  const d = toPlanar(secondTo, latitude);
  const denominator = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);

  if (Math.abs(denominator) < 0.00001) {
    return [firstFrom, firstTo, secondFrom, secondTo].find((point) =>
      pointOnSegment(point, firstFrom, firstTo) && pointOnSegment(point, secondFrom, secondTo));
  }

  const firstParameter = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / denominator;
  const secondParameter = ((a.x - c.x) * (a.y - b.y) - (a.y - c.y) * (a.x - b.x)) / denominator;
  if (firstParameter < -0.00001 || firstParameter > 1.00001 ||
      secondParameter < -0.00001 || secondParameter > 1.00001) {
    return undefined;
  }

  return interpolateCoordinate(firstFrom, firstTo, firstParameter);
};

/** True when two segments run close enough to parallel to count as "the same line". */
export const segmentsParallel = (
  firstFrom: Coordinate,
  firstTo: Coordinate,
  secondFrom: Coordinate,
  secondTo: Coordinate,
  tolerance = 0.42,
): boolean => {
  const latitude = (firstFrom.lat + firstTo.lat + secondFrom.lat + secondTo.lat) / 4;
  const a = toPlanar(firstFrom, latitude);
  const b = toPlanar(firstTo, latitude);
  const c = toPlanar(secondFrom, latitude);
  const d = toPlanar(secondTo, latitude);
  const firstLength = Math.hypot(b.x - a.x, b.y - a.y);
  const secondLength = Math.hypot(d.x - c.x, d.y - c.y);
  if (firstLength < 1 || secondLength < 1) return false;
  const sine = Math.abs((b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)) /
    (firstLength * secondLength);
  return sine < tolerance;
};
