# Pathless

Pathless is an open-source prototype for terrain-aware routing across both mapped and unmapped land. A normal map router can only choose among the paths it knows. Pathless is intended to combine known paths with terrain evidence so that a route can explain when it stays on a mapped track, when it crosses open ground, and what terrain signal influenced that choice.

The project is deliberately a prototype. The checked-in demo fixture is small, deterministic, and synthetic so the UI and routing engine can be developed without downloading or redistributing a large geospatial dataset.

## What is in the current prototype

The demo data contract in [`src/data/demo.ts`](src/data/demo.ts) provides:

- a fictional Pine Ridge pilot boundary and map view;
- default start and end points;
- three illustrative mapped trails and tracks that correspond to the engine's synthetic path corridors;
- human-readable elevation, slope, land-cover, and wetness layer labels;
- source and attribution metadata for the synthetic fixture and planned external adapters;
- a small terrain-grid metadata constant for deterministic UI/engine fixtures.

The geometry is ready to render in a Leaflet-based UI and to seed a route-engine experiment. It is not a claim that these paths, terrain values, or access conditions exist in the real world. No live OSM, Geoportal, or LiDAR dataset is bundled by this repository.

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

## Synthetic pilot area

The Pine Ridge pilot is a deliberately fictional extent near Gdynia West, Poland, bounded by approximately 54.4422–54.4746 latitude and 18.4813–18.5371 longitude. The boundary is a simple closed polygon, and all coordinate objects use Leaflet/engine `{ lat, lng }` order. The name and regional label make the map pleasant to inspect while the data flags make its synthetic status explicit.

The three paths are illustrative lines for testing mapped-versus-unmapped decisions. They are not verified roads or trails, and they do not encode permission, safety, surface condition, or current accessibility. The terrain layer labels describe synthetic relative values and classes rather than a real elevation model.

## Data and adapter direction

The data module keeps source metadata separate from routing policy. Future adapters should normalize external data into the same small contract and leave cost functions, barriers, and route selection to the engine.

- **OpenStreetMap** is the intended source for mapped ways, tracks, and possibly a basemap. Keep `© OpenStreetMap contributors` visible when OSM-derived data or tiles are shown, follow the [ODbL requirements](https://www.openstreetmap.org/copyright), and review the service's usage limits before production use.
- **Geoportal** is an intended source for Polish reference layers such as land cover, orthophotography, or public elevation services. The [Geoportal portal](https://www.geoportal.gov.pl/) exposes multiple services with different terms; an adapter must record the specific layer, date, CRS, attribution, and usage conditions.
- **LiDAR/elevation** is intended to supply a normalized elevation surface and derived terrain signals such as slope, roughness, and wetness proxies. The adapter should preserve source resolution and vertical datum metadata and should not assume that a derived value is a safety guarantee.

A production adapter should also make freshness, coverage gaps, confidence, and uncertainty explicit. A missing mapped path is not evidence that no path exists, and an apparently passable terrain cell is not permission to cross it.

## Legal and data caveats

This repository is source code plus a synthetic fixture. Before connecting a real provider:

1. read the current license and service terms for every layer and endpoint;
2. preserve required attribution and, where applicable, ODbL-derived-database obligations;
3. check rate limits, caching, tile-use rules, and redistribution restrictions;
4. verify access rights, protected-area rules, private land, seasonal closures, and local safety guidance;
5. treat routes across unmapped land as suggestions for investigation, never as proof of access or a safe path;
6. avoid presenting stale or low-confidence terrain data as authoritative navigation advice.

The project is not legal, surveying, emergency-response, or outdoor-safety advice. The adapter metadata is intentionally conservative; provider-specific legal review remains necessary.

## Next steps

1. Wire the synthetic fixture into the typed routing engine and UI with an explicit mapped-path baseline and terrain-aware alternative.
2. Add deterministic synthetic elevation cells and tests for barriers, coverage gaps, and route explanations.
3. Implement opt-in OSM, Geoportal, and LiDAR adapters with caching, CRS normalization, freshness, and provenance.
4. Show confidence and uncertainty in the UI, including why an unmapped segment was selected.
5. Add route safety checks, protected-area/access overlays, exportable provenance, and integration tests before treating results as operational.

## License

Pathless is released under the [MIT License](LICENSE). External datasets and services retain their own licenses and terms; the project license does not grant rights to third-party data.
