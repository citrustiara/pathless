# Pathless

Pathless is an open-source prototype for terrain-aware routing across both mapped and unmapped land. A normal map router can only choose among the paths it knows. Pathless combines known paths with measured terrain, so a route can say when it stays on a mapped track, when it crosses open ground, and what the ground actually does along the way.

The guiding rule is that the engine does not score what it cannot measure. Elevation, grade, climb, and travel time come from a real elevation model. Surface comes from the way's own OpenStreetMap tags. Vegetation, deadfall, and undergrowth are not modelled at all, and the UI says so rather than inventing a number for them.

## What the prototype does

- Loads a real elevation model for the working area from the public [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) and resamples it to roughly 12 m spacing.
- Draws that elevation as contour lines and a hypsometric tint with shaded relief, both computed in the browser from the same grid the router uses.
- Routes over a checked-in OpenStreetMap snapshot of Sopocka, joining mapped ways with A\* connectors across the terrain grid.
- Costs every metre as estimated travel time, from a normalised Tobler hiking curve applied to the real local grade, scaled by the way's mapped surface and by the chosen travel style.
- Enforces limits that mean something on the ground: a maximum grade along the route, a maximum length for any single off-trail stretch, and explicit permissions for crossing streets, walking along streets, and entering mapped watercourses.
- Offers up to three honestly labelled options: balanced, most direct, and stay-on-trails. Objectives that agree on the same line are offered once, not relabelled.
- Reports distance, moving time, climb, steepest grade, an elevation profile, and a surface breakdown taken from OSM tags.
- Exports GPX and GeoJSON with elevation, and keeps the full request in the URL so a route can be shared or reloaded.

The OSM snapshot is real map data, but it does not prove that a way is open, legal, safe, or passable today. A route across unmapped land is a suggestion to investigate, never navigation advice.

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
- [`src/engine/terrain.ts`](src/engine/terrain.ts) lays a 25 m routing grid over the area, filling it with elevation, Horn-method slope, a terrain ruggedness index, and proximity to mapped watercourses.
- [`src/engine/osm-router.ts`](src/engine/osm-router.ts) builds the way graph, derives street-crossing evidence from where paths and roads actually intersect, and searches the combined network.
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
