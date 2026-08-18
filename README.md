# Pathless

Pathless is an open-source prototype for terrain-aware routing across both mapped and unmapped land. A normal map router can only choose among the paths it knows. Pathless is intended to combine known paths with terrain evidence so that a route can explain when it stays on a mapped track, when it crosses open ground, and what terrain signal influenced that choice.

The project is deliberately a prototype. The map uses a bounded, checked-in OpenStreetMap snapshot around the supplied Sopocka forest coordinate. The current elevation and terrain-cost model is still deterministic synthetic data; it is labelled as such in the UI and is the seam for a future Geoportal/LiDAR adapter.

## What is in the current prototype

The current prototype provides:

- a real OSM tile basemap centered on `54.458403, 18.509192`;
- a normalized OSM snapshot in [`src/data/sopocka-osm.json`](src/data/sopocka-osm.json) containing roads, tracks, footways, cycleways, and water features around Sopocka;
- real imported path geometry highlighted on top of the basemap;
- an OSM-network router for nearest-path, destination, and waypoint route experiments;
- a low-opacity Geoportal NMT hillshade layer for real terrain context;
- hard slope, roughness, water, road-crossing, and road-walking constraints, with road permissions off by default;
- sampled 25 m terrain-grid A* connectors that bend around steep or rough cells instead of drawing an unchecked straight line;
- explicit source labels distinguishing OSM geometry, Geoportal visualization, and synthetic elevation costs.

The OSM snapshot is real map data, but it does not prove that a way is open, legal, safe, or passable today. The route line is still a prototype terrain result and must not be treated as navigation advice.

## Run locally

Use the repository's existing package setup:

```bash
npm install
npm run dev
```

Vite serves the development app at the address it prints, normally `http://127.0.0.1:4173`.

Useful checks:

```bash
npm run lint
npm run build
npm run preview
```

The `test` script is already defined in `package.json`; add or run Vitest tests as the engine and UI grow.

## Terrain prototype and imported area

The map view covers the supplied Sopocka forest area near Gdynia, Poland, bounded by approximately 54.4422–54.4746 latitude and 18.4813–18.5371 longitude. OSM ways are stored as `[latitude, longitude]` pairs for the Leaflet map. The app uses a synthetic 25 m terrain preview grid centered on the same coordinate for slope, roughness, water-risk, and ascent costs. The Geoportal hillshade is real NMT-derived imagery, but its pixels are not sampled into the route cost function: hillshade is a visualization, not an elevation raster. A no-route result is shown honestly when hard constraints leave no feasible connection.

The older [`src/data/demo.ts`](src/data/demo.ts) module remains as a typed synthetic fixture for engine tests and adapter contracts. It is not rendered as the basemap or presented as real-world geometry.

## Data and adapter direction

The data module keeps source metadata separate from routing policy. Future adapters should normalize external data into the same small contract and leave cost functions, barriers, and route selection to the engine.

- **OpenStreetMap** supplies the current basemap and imported mapped ways. The snapshot can be regenerated from an Overpass response with [`scripts/import-osm.mjs`](scripts/import-osm.mjs). Keep `© OpenStreetMap contributors` visible when OSM-derived data or tiles are shown, follow the [ODbL requirements](https://www.openstreetmap.org/copyright), and review the service's usage limits before production use.
- **Geoportal** supplies the current hillshade overlay through its NMT WMS service and remains an intended source for sampled elevation, land cover, and orthophotography. The [Geoportal portal](https://www.geoportal.gov.pl/) exposes multiple services with different terms; an adapter must record the specific layer, date, CRS, attribution, and usage conditions.
- **LiDAR/elevation** is intended to supply a normalized elevation surface and derived terrain signals such as slope, roughness, and wetness proxies. The adapter should preserve source resolution and vertical datum metadata and should not assume that a derived value is a safety guarantee.

A production adapter should also make freshness, coverage gaps, confidence, and uncertainty explicit. A missing mapped path is not evidence that no path exists, and an apparently passable terrain cell is not permission to cross it.

## Legal and data caveats

This repository is source code, a bounded OSM-derived snapshot, and a synthetic terrain fixture. Before refreshing or connecting a real provider:

1. read the current license and service terms for every layer and endpoint;
2. preserve required attribution and, where applicable, ODbL-derived-database obligations;
3. check rate limits, caching, tile-use rules, and redistribution restrictions;
4. verify access rights, protected-area rules, private land, seasonal closures, and local safety guidance;
5. treat routes across unmapped land as suggestions for investigation, never as proof of access or a safe path;
6. avoid presenting stale or low-confidence terrain data as authoritative navigation advice.

The project is not legal, surveying, emergency-response, or outdoor-safety advice. The adapter metadata is intentionally conservative; provider-specific legal review remains necessary.

## Next steps

1. Sample Geoportal/LiDAR elevation values into the route cost function with CRS, resolution, freshness, and vertical-datum metadata.
2. Improve OSM graph snapping and add land-cover, protected-area, access, and seasonal-closure constraints.
3. Show confidence and uncertainty in the UI, including why an unmapped segment was selected.
4. Add exportable provenance and integration tests before treating results as operational.

## License

Pathless is released under the [MIT License](LICENSE). External datasets and services retain their own licenses and terms; the project license does not grant rights to third-party data.
