/**
 * The Worker-backed counterpart to `createTerrainModel`.
 *
 * `App.tsx` uses this once real elevation loads, so the ~1.6 million-cell
 * grid build never runs inside a React render — see `terrain.worker.ts` for
 * where the work actually happens.
 */
import {
  createTerrainModelFromArrays,
  terrainGridGeometry,
  type BuildTerrainGridArraysInput,
  type TerrainGridArrays,
  type TerrainModelOptions,
} from "./terrain";
import type { TerrainModel } from "./types";

/**
 * Same result as `createTerrainModel(options)`, built off the main thread.
 * Rejects if this browser has no Worker support (or the worker itself
 * fails); the caller is expected to fall back to the synchronous
 * `createTerrainModel` in that case.
 *
 * Each build owns its worker. The app currently builds once, and keeping a
 * shared worker would make overlapping callers receive whichever response
 * arrived first unless the protocol also carried request IDs.
 */
export const createTerrainModelInWorker = (options: TerrainModelOptions): Promise<TerrainModel> =>
  new Promise((resolve, reject) => {
    let activeWorker: Worker;
    try {
      activeWorker = new Worker(new URL("./terrain.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    // Only the plain-data fields cross the postMessage boundary — an
    // ElevationGrid's `sample` closure would fail to structured-clone.
    const request: BuildTerrainGridArraysInput = {
      geometry: terrainGridGeometry(options.bounds, options.cellSizeMeters),
      elevation: options.elevation && {
        bounds: options.elevation.bounds,
        rows: options.elevation.rows,
        columns: options.elevation.columns,
        data: options.elevation.data,
        latitudeStep: options.elevation.latitudeStep,
        longitudeStep: options.elevation.longitudeStep,
      },
      waterways: options.waterways ?? [],
    };

    const cleanup = (): void => {
      activeWorker.removeEventListener("message", onMessage as EventListener);
      activeWorker.removeEventListener("error", onError as EventListener);
      activeWorker.removeEventListener("messageerror", onMessageError as EventListener);
      activeWorker.terminate();
    };
    const onMessage = (event: MessageEvent<TerrainGridArrays>): void => {
      cleanup();
      resolve(createTerrainModelFromArrays(options, event.data));
    };
    const onError = (event: ErrorEvent): void => {
      cleanup();
      reject(event.error instanceof Error ? event.error : new Error(event.message || "Terrain worker failed"));
    };
    const onMessageError = (): void => {
      cleanup();
      reject(new Error("Terrain worker returned data that could not be decoded"));
    };

    activeWorker.addEventListener("message", onMessage as EventListener);
    activeWorker.addEventListener("error", onError as EventListener);
    activeWorker.addEventListener("messageerror", onMessageError as EventListener);
    // `data` is not transferred (only the response arrays are): structured
    // clone copies it, so the caller's own ElevationGrid stays usable for
    // the hillshade/contour/tint layers and cursor elevation lookups.
    try {
      activeWorker.postMessage(request);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
