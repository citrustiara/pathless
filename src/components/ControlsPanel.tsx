import {
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Footprints,
  Mountain,
  Plus,
  Route,
  SlidersHorizontal,
  Sparkles,
  Target,
  TreePine,
  Waves,
} from "lucide-react";
import type { AppMode, MapPoint, PlacementMode, ProfileId, RouteSettings } from "./pathless-types";

type ControlsPanelProps = {
  mode: AppMode;
  profile: ProfileId;
  settings: RouteSettings;
  start: MapPoint;
  target: MapPoint;
  waypoints: MapPoint[];
  placementMode: PlacementMode;
  isCalculating: boolean;
  onModeChange: (mode: AppMode) => void;
  onProfileChange: (profile: ProfileId) => void;
  onSettingsChange: (settings: RouteSettings) => void;
  onPlacementModeChange: (mode: Exclude<PlacementMode, null>) => void;
  onClearWaypoint: (index: number) => void;
  onReset: () => void;
  onRecalculate: () => void;
};

const modeItems: Array<{ id: AppMode; label: string; icon: typeof Route }> = [
  { id: "nearest", label: "Nearest path", icon: Compass },
  { id: "destination", label: "Destination", icon: Target },
  { id: "design", label: "Design route", icon: Route },
];

const profileItems: Array<{ id: ProfileId; label: string; detail: string; icon: typeof Footprints }> = [
  { id: "hiker", label: "Hiker", detail: "Steady pace · 4.5 km/h", icon: Footprints },
  { id: "runner", label: "Trail runner", detail: "Fast pace · 7.2 km/h", icon: Sparkles },
  { id: "all-terrain", label: "All-terrain", detail: "Mixed surface · 5.1 km/h", icon: Mountain },
];

type RangeControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueLabel: string;
  helpText: string;
  onChange: (value: number) => void;
};

function RangeControl({ label, value, min, max, step = 1, valueLabel, helpText, onChange }: RangeControlProps) {
  const progress = ((value - min) / (max - min)) * 100;

  return (
    <label className="range-control">
      <span className="range-label-row">
        <span>{label}</span>
        <strong>{valueLabel}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ background: `linear-gradient(90deg, #2f6fc4 ${progress}%, #dfe5e9 ${progress}%)` }}
        aria-label={label}
      />
      <span className="range-help">{helpText}</span>
    </label>
  );
}

type ToggleRowProps = {
  label: string;
  detail: string;
  checked: boolean;
  icon: typeof Waves;
  onChange: (value: boolean) => void;
};

function ToggleRow({ label, detail, checked, icon: Icon, onChange }: ToggleRowProps) {
  return (
    <label className="toggle-row">
      <span className="toggle-icon"><Icon size={14} /></span>
      <span className="toggle-copy"><strong>{label}</strong><small>{detail}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-label={label} />
      <span className={`toggle-switch ${checked ? "toggle-switch-on" : ""}`} aria-hidden="true"><span /></span>
    </label>
  );
}

function PointRow({
  kind,
  point,
  isActive,
  onPick,
}: {
  kind: "start" | "target";
  point: MapPoint;
  isActive: boolean;
  onPick: () => void;
}) {
  const isStart = kind === "start";
  return (
    <div className="point-row">
      <span className={`point-symbol point-symbol-${kind}`}>{isStart ? "A" : "B"}</span>
      <span className="point-copy"><strong>{isStart ? "Start point" : "Target point"}</strong><small>{point.label ?? (isStart ? "Click to place start" : "Click to place target")}</small></span>
      <button className={`point-pick-button ${isActive ? "point-pick-button-active" : ""}`} type="button" onClick={onPick}>
        {isActive ? "Place" : "Pick on map"}
      </button>
    </div>
  );
}

export function ControlsPanel({
  mode,
  profile,
  settings,
  start,
  target,
  waypoints,
  placementMode,
  isCalculating,
  onModeChange,
  onProfileChange,
  onSettingsChange,
  onPlacementModeChange,
  onClearWaypoint,
  onReset,
  onRecalculate,
}: ControlsPanelProps) {
  function patchSettings(next: Partial<RouteSettings>) {
    onSettingsChange({ ...settings, ...next });
  }

  return (
    <aside className="control-panel" aria-label="Route controls">
      <div className="panel-section panel-section-mode">
        <div className="section-kicker"><span>Route mode</span><span className="section-index">01</span></div>
        <div className="mode-tabs" role="tablist" aria-label="Route mode">
          {modeItems.map(({ id, label, icon: Icon }) => (
            <button
              className={`mode-tab ${mode === id ? "mode-tab-active" : ""}`}
              type="button"
              role="tab"
              aria-selected={mode === id}
              key={id}
              onClick={() => onModeChange(id)}
            >
              <Icon size={14} strokeWidth={1.9} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel-section panel-section-points">
        <div className="section-kicker"><span>Points</span><span className="section-index">02</span></div>
        <div className="points-stack">
          <PointRow kind="start" point={start} isActive={placementMode === "start"} onPick={() => onPlacementModeChange("start")} />
          <div className="point-connector"><span /></div>
          <PointRow kind="target" point={target} isActive={placementMode === "target"} onPick={() => onPlacementModeChange("target")} />
        </div>
        {mode === "design" && (
          <div className="waypoint-list">
            <div className="waypoint-heading"><span>Waypoints</span><span>{waypoints.length}/5</span></div>
            {waypoints.length === 0 ? (
              <button className="add-waypoint-empty" type="button" onClick={() => onPlacementModeChange("waypoint")}>
                <Plus size={14} /> Add a waypoint on the map
              </button>
            ) : (
              <>
                {waypoints.map((waypoint, index) => (
                  <div className="waypoint-row" key={`${waypoint.x}-${waypoint.y}-${index}`}>
                    <span className="waypoint-number">{index + 1}</span>
                    <span><strong>{waypoint.label ?? `Waypoint ${index + 1}`}</strong><small>Placed on map</small></span>
                    <button type="button" onClick={() => onClearWaypoint(index)} aria-label={`Remove waypoint ${index + 1}`}>×</button>
                  </div>
                ))}
                {waypoints.length < 5 && <button className="add-waypoint-button" type="button" onClick={() => onPlacementModeChange("waypoint")}><Plus size={13} /> Add waypoint</button>}
              </>
            )}
          </div>
        )}
      </div>

      <div className="panel-section panel-section-profile">
        <div className="section-kicker"><span>Travel profile</span><span className="section-index">03</span></div>
        <div className="profile-select-wrap">
          <select value={profile} onChange={(event) => onProfileChange(event.target.value as ProfileId)} aria-label="Travel profile">
            {profileItems.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
          </select>
          <ChevronDown size={15} />
        </div>
        <div className="profile-details">
          {(() => {
            const current = profileItems.find((item) => item.id === profile) ?? profileItems[0];
            const Icon = current.icon;
            return <><span className="profile-icon"><Icon size={15} /></span><span><strong>{current.label}</strong><small>{current.detail}</small></span><Check size={14} className="profile-check" /></>;
          })()}
        </div>
      </div>

      <div className="panel-section panel-section-terrain">
        <div className="section-kicker"><span>Terrain preferences</span><span className="section-index">04</span></div>
        <div className="slider-stack">
          <RangeControl label="Slope tolerance" value={settings.slope} min={10} max={70} valueLabel={`≤ ${settings.slope}%`} helpText="Avoids grades beyond this threshold" onChange={(value) => patchSettings({ slope: value })} />
          <RangeControl label="Ascent weight" value={settings.ascent} min={0} max={100} valueLabel={settings.ascent < 35 ? "Low" : settings.ascent > 70 ? "High" : "Balanced"} helpText="How strongly elevation affects routing" onChange={(value) => patchSettings({ ascent: value })} />
          <RangeControl label="Roughness tolerance" value={settings.roughness} min={1} max={5} valueLabel={`${settings.roughness}/5`} helpText="Loose ground, brush and unmapped terrain" onChange={(value) => patchSettings({ roughness: value })} />
          <RangeControl label="Path preference" value={settings.pathPreference} min={0} max={100} valueLabel={settings.pathPreference < 35 ? "Direct" : settings.pathPreference > 70 ? "Paths" : "Balanced"} helpText="Known paths ↔ shorter line through land" onChange={(value) => patchSettings({ pathPreference: value })} />
        </div>
        <div className="toggle-stack">
          <ToggleRow label="Allow water crossings" detail="Prefer bridges; cross shallow water if needed" checked={settings.allowWater} icon={Waves} onChange={(value) => patchSettings({ allowWater: value })} />
          <ToggleRow label="Route alternatives" detail="Show two lower-confidence options" checked={settings.alternatives} icon={ArrowDownUp} onChange={(value) => patchSettings({ alternatives: value })} />
        </div>
      </div>

      <div className="panel-section panel-section-legend">
        <div className="section-kicker"><span>Source & confidence</span><span className="section-index">05</span></div>
        <div className="legend-row"><span className="legend-line legend-line-blue" /><span>Mapped trail network</span><span className="legend-confidence">High</span></div>
        <div className="legend-row"><span className="legend-line legend-line-green" /><span>Terrain inference</span><span className="legend-confidence">Medium</span></div>
        <div className="legend-row"><span className="legend-line legend-line-orange" /><span>Unmapped / seasonal</span><span className="legend-confidence">Review</span></div>
      </div>

      <div className="panel-actions">
        <button className="button button-ghost" type="button" onClick={onReset}><SlidersHorizontal size={14} /> Reset</button>
        <button className="button button-primary" type="button" onClick={onRecalculate} disabled={isCalculating}>
          {isCalculating ? <span className="button-spinner" /> : <TreePine size={14} />}
          {isCalculating ? "Calculating" : "Recalculate route"}
          {!isCalculating && <ChevronRight size={14} />}
        </button>
      </div>
    </aside>
  );
}

