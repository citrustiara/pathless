/**
 * Runs `buildTerrainGridArrays` off the main thread.
 *
 * Everything this needs travels in as plain data (see `TerrainWorkerRequest`
 * in `terrain-async.ts`) and everything it returns is a `TerrainGridArrays`
 * bundle of typed arrays, handed back as transferables so the copy is free.
 * There is deliberately no class instance and no closure over a live
 * `ElevationGrid` crossing this boundary — neither would survive
 * `postMessage`.
 *
 * TypeScript here is compiled against the DOM lib (the same tsconfig as the
 * rest of the app — see the note on `WorkerScope` below), not the WebWorker
 * lib, so `self` types as `Window`. The casts below are narrow: just enough
 * to call the two worker APIs this file actually uses.
 */
import { buildTerrainGridArrays, type BuildTerrainGridArraysInput, type TerrainGridArrays } from "./terrain";

type WorkerScope = {
  postMessage(message: TerrainGridArrays, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<BuildTerrainGridArraysInput>) => void): void;
};

const scope = self as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
  const result = buildTerrainGridArrays(event.data);
  scope.postMessage(result, [
    result.elevationMeters.buffer,
    result.waterRisk.buffer,
    result.slopeMeanDegrees.buffer,
    result.maxSlopeDegrees.buffer,
    result.ruggednessMeters.buffer,
  ]);
});
