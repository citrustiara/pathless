# Pathless

Pathless is an open-source prototype for terrain-aware routing across both mapped and unmapped land. A normal map router can only choose among the paths it knows. Pathless combines known paths with measured terrain, so a route can say when it stays on a mapped track, when it crosses open ground, and what the ground actually does along the way.

The guiding rule is that the engine does not score what it cannot measure. Elevation, grade, climb, and travel time come from a real elevation model. Surface comes from the way's own OpenStreetMap tags. Vegetation, deadfall, and undergrowth are not modelled at all, and the UI says so rather than inventing a number for them.

## What the prototype does

- Loads a real elevation model for the working area from the public [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) and resamples it to roughly 12 m spacing.
- Draws that elevation as contour lines and a shaded relief, computed in the browser from the same grid the router uses. A hypsometric colour tint is offered as a separate layer, because unlike the relief it replaces the base map's own land-cover colours rather than adding to them.
- Routes over a checked-in OpenStreetMap snapshot of Sopocka, joining mapped ways with connectors searched across a 5 m terrain grid. Each off-trail step may reach up to two cells, which gives the search 16 headings rather than the 8 a plain neighbour grid allows, so a line that does not happen to run at a multiple of 45 degrees comes out as that line instead of as a staircase approximating it.
- Costs every metre as estimated travel time, from a normalised Tobler hiking curve applied to the real local grade, scaled by the way's mapped surface and by the chosen travel style.
- Enforces limits that mean something on the ground: a maximum grade along the route, a maximum length for any single off-trail stretch, and explicit permissions for crossing streets, walking along streets, and entering mapped watercourses.
- Refuses to draw an off-trail line through a mapped wall, fence or hedge unless OpenStreetMap records a gate or stile there. Guard rails, bollards and ditches are imported too but do not block, because they stop a vehicle rather than someone on foot. Only mapped barriers are known; an unrecorded fence is still an unrecorded fence.
- Says when a start, target or waypoint falls outside the surveyed area, because the elevation grid clamps to its nearest edge rather than failing, and a clamped height is not a measured one.
- Offers up to three honestly labelled options: balanced, most direct, and stay-on-trails. Objectives that agree on the same line are offered once, not relabelled.
- Reports distance, moving time, climb, steepest grade, an elevation profile, and a surface breakdown taken from OSM tags.
- Exports GPX and GeoJSON with elevation, and keeps the full request in the URL so a route can be shared or reloaded.

The OSM snapshot is real map data, but it does not prove that a way is open, legal, safe, or passable today. A route across unmapped land is a suggestion to investigate, never navigation advice.

### Why routes bend the way they do

Nothing in the engine has a rule about switchbacks. Height gained per minute is
grade times speed, and for the normalised Tobler curve the router already used
that product peaks at a grade of 1/3.5 — 28.6%, or 15.9 degrees. Past that, a
traverse reaches a point above you sooner than the direct line does. Llobera &
Sluckin (2007) derive the same threshold at 16 degrees from metabolic cost,
independently of Tobler.

So the preference was always in the cost function; what suppressed it was the
grid. Given a fall line of 57% and a ceiling of 90% — nothing forbidding the
direct climb — the router now settles at about 27%. A grade penalty layered on
top would double-count a calibration that is already right.

### How this compares

Worth knowing what the neighbouring projects do, and where this deliberately
differs.

- **[BRouter](https://brouter.de/brouter/)** is the established off-road router
  over OSM. It reads SRTM at its original 90 m spacing and low-pass filters it.
  This engine measures grade against a 2 m LIDAR grid sampled every 4 m, so a
  short bank trips the grade cap here and would be averaged away there.
- **[Skitourenguru](https://www.skitourenguru.com/)** routes across open alpine
  ground, which is the closest thing to the problem this solves. It runs
  Dijkstra over a cost surface derived from slope angle, curvature and
  forestation, via GRASS `r.walk` — architecturally the same shape as the
  connector search here.
- **[GRASS `r.walk`](https://grass.osgeo.org/grass-stable/manuals/r.walk.html)**,
  the tool underneath that, offers 8 neighbours by default and 16 behind its
  knight's-move flag, noted as more accurate and more expensive. 16 is what this
  uses, so the move set is at the ceiling that the standard GIS tool offers.
- **Navmesh string pulling**, the games-industry path smoother, is provably
  optimal — but only within a corridor of uniform-cost polygons. That
  assumption does not hold on weighted, direction-dependent terrain, which is
  why the smoothing pass here was removed rather than improved.

Two things the neighbours have that this does not, on purpose:

- **Turn cost.** BRouter carries an explicit per-turn term. Measured over four
  real off-trail routes here, the median turn between segments is 4 degrees and
  only 2 of 88 turns double back at all, so there is next to no jitter for such
  a term to suppress — and it would tax the switchbacks on steep ground, which
  are the point. BRouter's turn cost models junction behaviour on a way network,
  which is a different job.
- **Curvature.** Skitourenguru separates a convex spur from a concave gully, and
  the second derivative is cheap given the gradient field already computed here.
  It is left out because there is no defensible weight to give it: picking one
  would be inventing a number, which is the thing this engine does not do.

## Run locally

```bash
npm install
npm run dev
```

Vite serves the app at `http://127.0.0.1:4173`.

```bash
npm run lint
npm test
npm run build
```

## How it fits together

```
elevation tiles ──► ElevationGrid ──┬─► contours + relief raster  (src/components/TerrainLayers.tsx)
                                    │
OSM snapshot ──► routing graph ─────┴─► TerrainModel ──► planOSMRoute  (src/engine/osm-router.ts)
```

- [`src/engine/elevation.ts`](src/engine/elevation.ts) fetches and decodes terrarium tiles into a latitude/longitude-regular grid, and derives contour polylines with marching squares.
- [`src/engine/terrain.ts`](src/engine/terrain.ts) lays a 5 m routing grid over the area, filling it with elevation, slope, a terrain ruggedness index, and proximity to mapped watercourses. Slope is measured on the elevation source's own grid and then aggregated per cell as both a mean and a maximum, not fitted across the routing step: over this area, measuring at a 25 m stride left a thousand cells reading as gentle ground while holding a slope past 20 degrees somewhere inside them.
- [`src/engine/osm-router.ts`](src/engine/osm-router.ts) builds the way graph, derives street-crossing evidence from where paths and roads actually intersect, holds the mapped barriers and their gates as a separate layer that off-trail lines may not cross, and searches the combined network.
- [`scripts/sopocka.overpass`](scripts/sopocka.overpass) is the query behind the snapshot, and [`scripts/import-osm.mjs`](scripts/import-osm.mjs) bakes its response.
- [`src/engine/geo.ts`](src/engine/geo.ts) holds the small-area geodesy shared by all of the above.

### When elevation is unavailable

If the terrain tiles cannot be reached, the terrain model reports `hasElevation: false`, every cell stays at zero, and climb and grade are shown as `—` rather than as plausible-looking numbers. Routing still works on distance and surface alone, and both the route notes and the sidebar say what is missing.

## Imported area

The map covers the Sopocka forest area near Gdynia, Poland, bounded by 54.445–54.470 latitude and 18.480–18.535 longitude. OSM ways are stored as `[latitude, longitude]` pairs. The snapshot can be regenerated from an Overpass response with [`scripts/import-osm.mjs`](scripts/import-osm.mjs).

## Data and adapter direction

The data module keeps source metadata separate from routing policy. Future adapters should normalize external data into the same small contract and leave cost functions, barriers, and route selection to the engine.

- **OpenStreetMap** supplies the basemap and the imported ways. Keep `© OpenStreetMap contributors` visible wherever OSM-derived data or tiles are shown, follow the [ODbL requirements](https://www.openstreetmap.org/copyright), and review the tile usage policy before production use.
- **AWS Terrain Tiles** supply elevation, themselves assembled from SRTM, EU-DEM, and national sources of differing resolution and vintage. An adapter that replaces them should preserve source resolution and vertical-datum metadata.
- **Higher-resolution LiDAR**, such as the Polish Geoportal NMT, would improve grade accuracy and is the natural next source. It is also the only realistic route to modelling ground cover, which the current engine deliberately leaves out.

A production adapter should make freshness, coverage gaps, confidence, and uncertainty explicit. A missing mapped path is not evidence that no path exists, and an apparently passable terrain cell is not permission to cross it.

## Legal and data caveats

This repository is source code plus a bounded OSM-derived snapshot. Before refreshing or connecting a real provider:

1. read the current license and service terms for every layer and endpoint;
2. preserve required attribution and, where applicable, ODbL-derived-database obligations;
3. check rate limits, caching, tile-use rules, and redistribution restrictions;
4. verify access rights, protected-area rules, private land, seasonal closures, and local safety guidance;
5. treat routes across unmapped land as suggestions for investigation, never as proof of access or a safe path;
6. avoid presenting stale or low-confidence terrain data as authoritative navigation advice.

The project is not legal, surveying, emergency-response, or outdoor-safety advice.

## Next steps

1. Move routing into a worker so large areas stay interactive.
2. Add land-cover, protected-area, and seasonal-closure constraints from OSM polygons.
3. Sample a higher-resolution national DEM where one is available, keeping CRS and vertical-datum metadata.
4. Add exportable provenance before treating any result as operational.

## License

Pathless is released under the [MIT License](LICENSE). External datasets and services retain their own licenses and terms; the project license does not grant rights to third-party data.
