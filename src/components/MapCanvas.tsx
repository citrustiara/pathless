import L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { LatLngBoundsExpression } from "leaflet";
import { Crosshair, Layers, Minus, Plus, Maximize2, Route as RouteIcon } from "lucide-react";
import { SOPOCKA_BOUNDS, SOPOCKA_OSM_FEATURES, type OSMFeature } from "../data/sopocka";
import type { Coordinate, ElevationGrid, OSMRoute, TerrainModel } from "../engine";
import { suggestContourInterval } from "../engine";
import { ContourLayer, ElevationTintLayer } from "./TerrainLayers";
import type { AppMode, ElevationStatus, MapPoint, PlacementMode, RouteView } from "./pathless-types";

export type MapLayers = {
  tint: boolean;
  contours: boolean;
  paths: boolean;
};

type MapCanvasProps = {
  view: RouteView;
  mode: AppMode;
  start: MapPoint;
  target: MapPoint;
  waypoints: MapPoint[];
  placementMode: PlacementMode;
  isCalculating: boolean;
  elevationStatus: ElevationStatus;
  elevationGrid?: ElevationGrid;
  terrain: TerrainModel;
  layers: MapLayers;
  detailsHidden: boolean;
  hoverPoint?: Coordinate | null;
  onLayersChange: (layers: MapLayers) => void;
  onMapClick: (point: MapPoint) => void;
  onPlacementModeChange: (mode: PlacementMode) => void;
  onMovePoint: (kind: "start" | "target" | "waypoint", index: number, point: MapPoint) => void;
  onAddWaypoint: (point: MapPoint) => void;
  onSelectAlternative: (index: number) => void;
  children?: ReactNode;
};

const DATA_BOUNDS: LatLngBoundsExpression = [
  [SOPOCKA_BOUNDS.south, SOPOCKA_BOUNDS.west],
  [SOPOCKA_BOUNDS.north, SOPOCKA_BOUNDS.east],
];

const PAN_BOUNDS: LatLngBoundsExpression = [
  [SOPOCKA_BOUNDS.south - 0.02, SOPOCKA_BOUNDS.west - 0.03],
  [SOPOCKA_BOUNDS.north + 0.02, SOPOCKA_BOUNDS.east + 0.03],
];

const visibleOsmFeatures = SOPOCKA_OSM_FEATURES.filter((feature) =>
  feature.category === "path" || feature.category === "water" || feature.highway === "track");

const featureStyle = (feature: OSMFeature) => {
  if (feature.category === "water") return { color: "#5d94b0", weight: 2.2, opacity: 0.55 };
  if (feature.highway === "track") {
    return { color: "#96703f", weight: 2.1, opacity: 0.7, dashArray: "6 4" };
  }
  if (feature.highway === "steps") return { color: "#a8623f", weight: 2, opacity: 0.6, dashArray: "2 3" };
  return { color: "#a35f4a", weight: 1.7, opacity: 0.6, dashArray: "3 4" };
};

const pointIcon = (kind: string, label: string) =>
  L.divIcon({
    className: "map-pin-wrapper",
    html: `<span class="map-pin map-pin-${kind}">${label}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

const routeLatLngs = (route: OSMRoute): Array<[number, number]> =>
  route.coordinates.map(({ lat, lng }) => [lat, lng]);

/** Split the route so mapped ways and open ground can be drawn differently. */
const routeStrands = (route: OSMRoute): Array<{ mapped: boolean; points: Array<[number, number]> }> => {
  const strands: Array<{ mapped: boolean; points: Array<[number, number]> }> = [];
  for (const segment of route.segments) {
    const last = strands[strands.length - 1];
    if (last && last.mapped === segment.mappedPath) {
      last.points.push([segment.to.lat, segment.to.lng]);
    } else {
      strands.push({
        mapped: segment.mappedPath,
        points: [[segment.from.lat, segment.from.lng], [segment.to.lat, segment.to.lng]],
      });
    }
  }
  return strands;
};

function MapReady() {
  const map = useMap();
  useEffect(() => {
    map.fitBounds(DATA_BOUNDS, { padding: [24, 24] });
    const frame = window.requestAnimationFrame(() => map.invalidateSize());
    return () => window.cancelAnimationFrame(frame);
  }, [map]);
  return null;
}

/**
 * Leaflet only watches the window, so collapsing the rail or any other layout
 * change would leave the map rendering at its old size.
 */
function MapResizeWatcher() {
  const map = useMap();
  useEffect(() => {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => map.invalidateSize({ animate: false }));
    });
    observer.observe(map.getContainer());
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [map]);
  return null;
}

/**
 * The HUD lives inside the Leaflet container so it can use the map context.
 * Without this, a click on a button would also pan or zoom the map underneath.
 */
function MapOverlays({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    L.DomEvent.disableClickPropagation(ref.current);
    L.DomEvent.disableScrollPropagation(ref.current);
  }, []);
  return <div className="map-overlays" ref={ref}>{children}</div>;
}

function FitRoute({ route, detailsHidden }: { route?: OSMRoute; detailsHidden: boolean }) {
  const map = useMap();
  const signature = route ? `${route.id}:${route.coordinates.length}:${Math.round(route.distanceMeters)}` : "";

  useEffect(() => {
    if (!route || route.coordinates.length < 2) return;
    const frame = window.requestAnimationFrame(() => {
      map.invalidateSize();
      map.fitBounds(routeLatLngs(route), {
        paddingTopLeft: [70, 70],
        paddingBottomRight: detailsHidden ? [70, 70] : [400, 90],
        maxZoom: 16,
        animate: false,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [signature, detailsHidden, map, route]);

  return null;
}

export type MapContextMenu = {
  x: number;
  y: number;
  lat: number;
  lng: number;
};

function MapInteractions({
  placementMode,
  onMapClick,
  onCursorChange,
  onContextMenu,
}: {
  placementMode: PlacementMode;
  onMapClick: (point: MapPoint) => void;
  onCursorChange: (point: Coordinate | null) => void;
  onContextMenu: (menu: MapContextMenu | null) => void;
}) {
  useMapEvents({
    click: (event) => {
      onContextMenu(null);
      if (placementMode) onMapClick({ lat: event.latlng.lat, lng: event.latlng.lng });
    },
    contextmenu: (event) => onContextMenu({
      x: event.containerPoint.x,
      y: event.containerPoint.y,
      lat: event.latlng.lat,
      lng: event.latlng.lng,
    }),
    movestart: () => onContextMenu(null),
    zoomstart: () => onContextMenu(null),
    mousemove: (event) => onCursorChange({ lat: event.latlng.lat, lng: event.latlng.lng }),
    mouseout: () => onCursorChange(null),
  });
  return null;
}

function ScaleReadout() {
  const map = useMap();
  const [scale, setScale] = useState<{ label: string; width: number } | null>(null);

  const update = useCallback(() => {
    const bounds = map.getBounds();
    const centreLatitude = bounds.getCenter().lat;
    const metersPerPixel = map.distance(
      L.latLng(centreLatitude, bounds.getWest()),
      L.latLng(centreLatitude, bounds.getEast()),
    ) / map.getSize().x;
    const target = metersPerPixel * 90;
    const magnitude = 10 ** Math.floor(Math.log10(target));
    const rounded = [1, 2, 5, 10].map((step) => step * magnitude)
      .reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best));
    setScale({
      label: rounded >= 1_000 ? `${rounded / 1_000} km` : `${rounded} m`,
      width: rounded / metersPerPixel,
    });
  }, [map]);

  useMapEvents({ zoomend: update, moveend: update, resize: update });
  useEffect(update, [update]);

  if (!scale) return null;
  return (
    <div className="map-scale-bar" aria-label={`Map scale, ${scale.label}`}>
      <span className="map-scale-line" style={{ width: `${Math.round(scale.width)}px` }} />
      <span>{scale.label}</span>
    </div>
  );
}

function ZoomControls() {
  const map = useMap();
  return (
    <div className="map-control-stack">
      <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => map.zoomIn()}>
        <Plus size={15} />
      </button>
      <span className="map-control-divider" />
      <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => map.zoomOut()}>
        <Minus size={15} />
      </button>
      <span className="map-control-divider" />
      <button
        type="button"
        aria-label="Fit the mapped area"
        title="Fit the mapped area"
        onClick={() => map.fitBounds(DATA_BOUNDS, { padding: [24, 24] })}
      >
        <Maximize2 size={14} />
      </button>
    </div>
  );
}

export function MapCanvas({
  view,
  mode,
  start,
  target,
  waypoints,
  placementMode,
  isCalculating,
  elevationStatus,
  elevationGrid,
  terrain,
  layers,
  detailsHidden,
  hoverPoint,
  onLayersChange,
  onMapClick,
  onPlacementModeChange,
  onMovePoint,
  onAddWaypoint,
  onSelectAlternative,
  children,
}: MapCanvasProps) {
  const [cursor, setCursor] = useState<Coordinate | null>(null);
  const [contextMenu, setContextMenu] = useState<MapContextMenu | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const layersRef = useRef<HTMLDivElement>(null);

  const contourInterval = useMemo(
    () => (elevationGrid && elevationGrid.rows > 2 ? suggestContourInterval(elevationGrid) : 0),
    [elevationGrid],
  );

  useEffect(() => {
    if (!layersOpen) return;
    const close = (event: MouseEvent) => {
      if (!layersRef.current?.contains(event.target as Node)) setLayersOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [layersOpen]);

  const primary = view.route;
  const cursorElevation = cursor && terrain.hasElevation ? terrain.elevationAt(cursor) : null;

  const placementLabel = placementMode === "waypoint"
    ? "a waypoint"
    : placementMode === "target"
      ? "the target"
      : "the start";

  const togglePlacement = (next: Exclude<PlacementMode, null>) =>
    onPlacementModeChange(placementMode === next ? null : next);

  return (
    <div className={`map-surface ${placementMode ? "map-surface-placement" : ""}`}>
      <MapContainer
        className="leaflet-map"
        bounds={DATA_BOUNDS}
        maxBounds={PAN_BOUNDS}
        maxBoundsViscosity={0.7}
        minZoom={12}
        maxZoom={19}
        zoomControl={false}
        attributionControl={false}
        preferCanvas
        scrollWheelZoom
      >
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" maxZoom={19} />

        {elevationGrid && (
          <>
            <ElevationTintLayer grid={elevationGrid} visible={layers.tint} />
            <ContourLayer grid={elevationGrid} visible={layers.contours} interval={contourInterval} />
          </>
        )}

        <MapReady />
        <MapResizeWatcher />
        <FitRoute route={primary} detailsHidden={detailsHidden} />
        <MapInteractions
          placementMode={placementMode}
          onMapClick={onMapClick}
          onCursorChange={setCursor}
          onContextMenu={setContextMenu}
        />

        <Rectangle bounds={DATA_BOUNDS} pathOptions={{ color: "#6f8794", weight: 1, opacity: 0.4, fill: false, dashArray: "4 5" }} interactive={false} />

        {layers.paths && visibleOsmFeatures.map((feature) => (
          <Polyline
            key={feature.id}
            positions={feature.coordinates}
            pathOptions={featureStyle(feature)}
            interactive={Boolean(feature.name)}
          >
            {feature.name && <Tooltip sticky>{feature.name}</Tooltip>}
          </Polyline>
        ))}

        {view.alternatives.map((alternative, index) => (
          <Polyline
            key={alternative.id}
            positions={routeLatLngs(alternative)}
            pathOptions={{ color: "#5f7280", weight: 3.5, opacity: 0.55, dashArray: "7 6" }}
            eventHandlers={{ click: () => onSelectAlternative(index) }}
            className="route-alternative"
          >
            <Tooltip sticky>
              {alternative.objectiveLabel}: {(alternative.distanceMeters / 1_000).toFixed(1)} km,{" "}
              {Math.round(alternative.estimatedTimeMinutes)} min. Click to use it.
            </Tooltip>
          </Polyline>
        ))}

        {primary && primary.coordinates.length > 1 && (
          <>
            <Polyline
              positions={routeLatLngs(primary)}
              pathOptions={{ color: "#ffffff", weight: 9, opacity: 0.95, lineCap: "round", lineJoin: "round" }}
              interactive={false}
            />
            {routeStrands(primary).map((strand, index) => (
              <Polyline
                key={index}
                positions={strand.points}
                pathOptions={{
                  color: strand.mapped ? "#2a6fc4" : "#3f9a6b",
                  weight: 4.5,
                  opacity: 1,
                  lineCap: "round",
                  lineJoin: "round",
                  dashArray: strand.mapped ? undefined : "1 7",
                }}
                interactive={false}
              />
            ))}
          </>
        )}

        {hoverPoint && (
          <Marker position={[hoverPoint.lat, hoverPoint.lng]} icon={pointIcon("hover", "")} interactive={false} />
        )}

        <Marker
          position={[start.lat, start.lng]}
          icon={pointIcon("start", "A")}
          draggable
          eventHandlers={{
            dragend: (event) => {
              const { lat, lng } = event.target.getLatLng();
              onMovePoint("start", 0, { lat, lng });
            },
          }}
        >
          <Tooltip direction="top" offset={[0, -12]}>Start. Drag to move.</Tooltip>
        </Marker>

        {waypoints.map((waypoint, index) => (
          <Marker
            key={`waypoint-${index}`}
            position={[waypoint.lat, waypoint.lng]}
            icon={pointIcon("waypoint", String(index + 1))}
            draggable
            eventHandlers={{
              dragend: (event) => {
                const { lat, lng } = event.target.getLatLng();
                onMovePoint("waypoint", index, { lat, lng });
              },
            }}
          >
            <Tooltip direction="top" offset={[0, -12]}>Waypoint {index + 1}. Drag to move.</Tooltip>
          </Marker>
        ))}

        {mode !== "nearest" && (
          <Marker
            position={[target.lat, target.lng]}
            icon={pointIcon("target", "B")}
            draggable
            eventHandlers={{
              dragend: (event) => {
                const { lat, lng } = event.target.getLatLng();
                onMovePoint("target", 0, { lat, lng });
              },
            }}
          >
            <Tooltip direction="top" offset={[0, -12]}>Target. Drag to move.</Tooltip>
          </Marker>
        )}

        {mode === "nearest" && primary?.snappedDestination && (
          <Marker
            position={[primary.snappedDestination.lat, primary.snappedDestination.lng]}
            icon={pointIcon("snapped", "")}
            interactive={false}
          />
        )}

        <MapOverlays>
          <div className="overlay-corner overlay-top-left">
            <div className="map-place-tools">
              {(["start", "target", "waypoint"] as const).map((kind) => (
                <button
                  key={kind}
                  className={`map-place-button ${placementMode === kind ? "map-place-button-active" : ""}`}
                  type="button"
                  aria-pressed={placementMode === kind}
                  disabled={(kind === "target" && mode === "nearest") || (kind === "waypoint" && mode !== "design")}
                  title={kind === "waypoint" && mode !== "design"
                    ? "Switch to Design route to place waypoints"
                    : kind === "target" && mode === "nearest"
                      ? "Nearest path mode does not use a target"
                      : undefined}
                  onClick={() => togglePlacement(kind)}
                >
                  <span className={`place-dot place-dot-${kind}`} />
                  {kind === "start" ? "Start" : kind === "target" ? "Target" : "Waypoint"}
                </button>
              ))}
            </div>
            {placementMode && (
              <div className="map-placement-banner">
                <Crosshair size={13} />
                Click the map to place {placementLabel}. It stays selected, so you can keep placing.
                <button type="button" onClick={() => onPlacementModeChange(null)}>Done</button>
              </div>
            )}
          </div>

          <div className="overlay-corner overlay-top-right">
            <ZoomControls />
            <div className="map-layers" ref={layersRef}>
              <button
                className={`map-panel-button ${layersOpen ? "map-panel-button-active" : ""}`}
                type="button"
                aria-expanded={layersOpen}
                onClick={() => setLayersOpen((open) => !open)}
              >
                <Layers size={13} />
                Layers
              </button>
              {layersOpen && (
                <div className="map-layer-menu">
                  <div className="map-layer-menu-title">Map layers</div>
                  {([
                    ["tint", "Elevation shading", elevationStatus === "ready"],
                    ["contours", contourInterval > 0 ? `Contours every ${contourInterval} m` : "Contour lines", elevationStatus === "ready"],
                    ["paths", "Paths, tracks, streams", true],
                  ] as const).map(([key, label, enabled]) => (
                    <label key={key} className={`map-layer-item ${enabled ? "" : "map-layer-item-disabled"}`}>
                      <input
                        type="checkbox"
                        checked={layers[key] && enabled}
                        disabled={!enabled}
                        onChange={(event) => onLayersChange({ ...layers, [key]: event.target.checked })}
                      />
                      <span className={`layer-check ${layers[key] && enabled ? "layer-check-on" : ""}`} aria-hidden="true" />
                      <span>{label}</span>
                    </label>
                  ))}
                  <div className="map-legend">
                    <div className="map-legend-title">Route</div>
                    <span><i className="legend-swatch legend-swatch-mapped" />Mapped way</span>
                    <span><i className="legend-swatch legend-swatch-offtrail" />Open terrain</span>
                    <span><i className="legend-swatch legend-swatch-alternative" />Alternative</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="overlay-corner overlay-bottom-left">
            <div className="map-readout">
              <span className={`status-dot ${isCalculating ? "status-dot-blue" : view.status === "blocked" ? "status-dot-orange" : "status-dot-green"}`} />
              {isCalculating
                ? "Calculating"
                : view.status === "blocked"
                  ? "No route under the current limits"
                  : elevationStatus === "loading"
                    ? "Loading elevation"
                    : elevationStatus === "unavailable"
                      ? "Elevation unavailable"
                      : cursorElevation !== null
                        ? `${Math.round(cursorElevation)} m at cursor`
                        : `${primary ? (primary.distanceMeters / 1_000).toFixed(2) : "0.00"} km route`}
            </div>
            <ScaleReadout />
            <div className="map-attribution">
              Map data <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors,
              elevation from <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>
            </div>
          </div>

          <div className="overlay-corner overlay-bottom-right">{children}</div>

          {contextMenu && (
            <div
              className="map-context-menu"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              role="menu"
            >
              <button type="button" role="menuitem" onClick={() => { onMovePoint("start", 0, contextMenu); setContextMenu(null); }}>
                <span className="place-dot place-dot-start" />Start here
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={mode === "nearest"}
                title={mode === "nearest" ? "Nearest path mode does not use a target" : undefined}
                onClick={() => { onMovePoint("target", 0, contextMenu); setContextMenu(null); }}
              >
                <span className="place-dot place-dot-target" />Target here
              </button>
              <button type="button" role="menuitem" onClick={() => { onAddWaypoint(contextMenu); setContextMenu(null); }}>
                <span className="place-dot place-dot-waypoint" />Add waypoint here
              </button>
              <div className="map-context-readout">
                {contextMenu.lat.toFixed(5)}, {contextMenu.lng.toFixed(5)}
                {terrain.hasElevation && <b>{Math.round(terrain.elevationAt(contextMenu))} m</b>}
              </div>
            </div>
          )}
        </MapOverlays>
      </MapContainer>

      {!primary && !isCalculating && (
        <div className="map-blocked-flag">
          <RouteIcon size={14} />
          {view.blockedReason ?? "No route could be drawn."}
        </div>
      )}
    </div>
  );
}
