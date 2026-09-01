# Data sources and reuse terms

The MIT license in [`LICENSE`](LICENSE) covers Pathless source code. It does not replace the terms of the geographic datasets or live services described below.

## Checked-in OpenStreetMap snapshot

[`src/data/sopocka-osm.json`](src/data/sopocka-osm.json) is a bounded extract of OpenStreetMap data for the Sopocka area. The source snapshot reports an OSM timestamp of **2026-08-18T19:18:35Z** and was imported on **2026-08-18**.

The import selects routing ways, barriers, barrier openings, and the tags Pathless uses. It is therefore distributed as an OpenStreetMap-derived database under the **Open Database License (ODbL) 1.0**:

- Attribution and source terms: <https://www.openstreetmap.org/copyright>
- ODbL 1.0: <https://opendatacommons.org/licenses/odbl/1-0/>
- OSM Foundation attribution guidance: <https://osmfoundation.org/wiki/Licence/Attribution_Guidelines>
- Reproducible query and transformation: [`scripts/sopocka.overpass`](scripts/sopocka.overpass) and [`scripts/import-osm.mjs`](scripts/import-osm.mjs)

Required attribution: **© OpenStreetMap contributors**. Anyone redistributing or modifying the snapshot must comply with the ODbL, including its attribution, notice, and share-alike requirements.

The basemap tiles displayed by the app are fetched live from OpenStreetMap and are not included in this repository. Their use is separately subject to the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/). The attribution remains visible in the map UI.

## Checked-in GUGiK terrain snapshot

[`src/data/sopocka-dtm.json`](src/data/sopocka-dtm.json) was obtained on **2026-08-18** from the Polish Head Office of Geodesy and Cartography (**Główny Urząd Geodezji i Kartografii, GUGiK**) through its public NMT WCS coverage `DTM_PL-EVRF2007-NH`. The service metadata identifies the coverage publication year as **2011**.

Pathless processed the source data: EPSG:2180 AAIGrid tiles were mosaicked, bilinearly resampled onto a roughly 3 m geographic grid, quantized to decimetres, and encoded into the checked-in snapshot. GUGiK does not warrant the correctness, currency, completeness, or quality of this processed result. The snapshot's older compact `license` label is only shorthand; it does not waive the official reuse conditions below.

GUGiK publishes NMT as open public-sector information available for reuse. Its reuse conditions require identification of the source and relevant dates, and disclosure that the information was processed:

- NMT dataset page: <https://www.geoportal.gov.pl/pl/dane/numeryczny-model-terenu-nmt/>
- GUGiK open-data overview: <https://www.gov.pl/web/gugik-en/data>
- Official public-sector information reuse terms: <https://www.gov.pl/web/gugik/ponowne-wykorzystanie-informacji-sektora-publicznego>
- Reproducible download and transformation: [`scripts/import-dtm.mjs`](scripts/import-dtm.mjs)

Required source notice: **Główny Urząd Geodezji i Kartografii (GUGiK), Numeryczny Model Terenu (NMT), coverage `DTM_PL-EVRF2007-NH`; obtained 2026-08-18; processed by Pathless as described above.**

## Runtime terrain fallback

When the checked-in GUGiK snapshot cannot load, Pathless may fetch Mapzen/Tilezen Terrain Tiles from the AWS Registry of Open Data. No fallback tiles are committed to this repository. For the current Polish working area, the service's `X-Imagery-Sources` metadata identifies EU-DEM as the underlying source.

- AWS Terrain Tiles listing: <https://registry.opendata.aws/terrain-tiles/>
- Mapzen/Tilezen source attribution: <https://github.com/tilezen/joerd/blob/master/docs/attribution.md>
- EU-DEM catalogue: <https://www.eea.europa.eu/en/datahub/datahubitem-view/d08852bc-7b5f-4835-a776-08362e2fbf4b/folder_contents>

Applicable credit for this area: **Mapzen Terrain Tiles; terrain data produced using Copernicus data and information funded by the European Union — EU-DEM layers.** The app displays the active elevation source in its map attribution.
