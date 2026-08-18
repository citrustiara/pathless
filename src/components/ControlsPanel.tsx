import {
  Bike,
  Compass,
  CornerUpRight,
  Footprints,
  MoveHorizontal,
  Plus,
  RotateCcw,
  Route,
  Target,
  TrendingUp,
  Waves,
  Wind,
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
  onPlacementModeChange: (mode: PlacementMode) => void;
  onClearWaypoint: (index: number) => void;
  onReset: () => void;
};

const MODES: Array<{ id: AppMode; label: string; icon: typeof Route; hint: string }> = [
  { id: "nearest", label: "Nearest path", icon: Compass, hint: "Shortest way from the start to any mapped path" },
  { id: "destination", label: "Destination", icon: Target, hint: "Route from the start to the target" },
  { id: "design", label: "Design route", icon: Route, hint: "Route through waypoints in order" },
];

const PROFILES: Array<{ id: ProfileId; label: string; detail: string; icon: typeof Footprints }> = [
  { id: "hiker", label: "Hiker", detail: "4.6 km/h on level trail", icon: Footprints },
  { id: "runner", label: "Trail runner", detail: "7.6 km/h on level trail", icon: Wind },
  { id: "mtb", label: "Mountain bike", detail: "12 km/h on level trail", icon: Bike },
];

const formatCoordinate = (point: MapPoint): string =>
  `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;

type RangeControlProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueLabel: string;
  helpText: string;
  icon: typeof TrendingUp;
  onChange: (value: number) => void;
};

function RangeControl({ label, value, min, max, step = 1, valueLabel, helpText, icon: Icon, onChange }: RangeControlProps) {
  const progress = ((value - min) / (max - min)) * 100;
  return (
    <label className="range-control">
      <span className="range-label-row">
        <span className="range-label"><Icon size={13} />{label}</span>
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
  disabled = false,
  shortcut,
  onPick,
}: {
  kind: "start" | "target";
  point: MapPoint;
  isActive: boolean;
  disabled?: boolean;
  shortcut: string;
  onPick: () => void;
}) {
  const isStart = kind === "start";
  return (
    <div className={`point-row ${isActive ? "point-row-active" : ""}`}>
      <span className={`point-symbol point-symbol-${kind}`}>{isStart ? "A" : "B"}</span>
      <span className="point-copy">
        <strong>{isStart ? "Start" : "Target"}</strong>
        <small>{disabled ? "Used in Destination and Design route" : formatCoordinate(point)}</small>
      </span>
      <button
        className={`point-pick-button ${isActive ? "point-pick-button-active" : ""}`}
        type="button"
        onClick={onPick}
        disabled={disabled}
        title={`Place on the map (${shortcut})`}
      >
        {disabled ? "Unused" : isActive ? "Placing" : "Place"}
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
}: ControlsPanelProps) {
  const patch = (next: Partial<RouteSettings>) => onSettingsChange({ ...settings, ...next });
  const togglePlacement = (next: Exclude<PlacementMode, null>) =>
    onPlacementModeChange(placementMode === next ? null : next);
  const activeMode = MODES.find((item) => item.id === mode) ?? MODES[0];

  return (
    <aside className="control-panel" aria-label="Route controls">
      <div className="panel-section">
        <div className="section-kicker"><span>Route mode</span></div>
        <div className="mode-tabs" role="tablist" aria-label="Route mode">
          {MODES.map(({ id, label, icon: Icon }) => (
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
        <p className="section-note">{activeMode.hint}</p>
      </div>

      <div className="panel-section">
        <div className="section-kicker">
          <span>Points</span>
          <span className="section-aside">{isCalculating ? "Recalculating" : "Live"}</span>
        </div>
        <div className="points-stack">
          <PointRow
            kind="start"
            point={start}
            shortcut="S"
            isActive={placementMode === "start"}
            onPick={() => togglePlacement("start")}
          />
          <div className="point-connector"><span /></div>
          <PointRow
            kind="target"
            point={target}
            shortcut="T"
            disabled={mode === "nearest"}
            isActive={placementMode === "target"}
            onPick={() => togglePlacement("target")}
          />
        </div>
        {mode === "design" && (
          <div className="waypoint-list">
            <div className="waypoint-heading"><span>Waypoints</span><span>{waypoints.length} of 8</span></div>
            {waypoints.length === 0 ? (
              <button
                className={`add-waypoint-empty ${placementMode === "waypoint" ? "add-waypoint-active" : ""}`}
                type="button"
                onClick={() => togglePlacement("waypoint")}
              >
                <Plus size={14} />
                {placementMode === "waypoint" ? "Click the map to add waypoints" : "Add a waypoint on the map"}
              </button>
            ) : (
              <>
                {waypoints.map((waypoint, index) => (
                  <div className="waypoint-row" key={`${waypoint.lat}-${waypoint.lng}-${index}`}>
                    <span className="waypoint-number">{index + 1}</span>
                    <span><strong>Waypoint {index + 1}</strong><small>{formatCoordinate(waypoint)}</small></span>
                    <button type="button" onClick={() => onClearWaypoint(index)} aria-label={`Remove waypoint ${index + 1}`}>×</button>
                  </div>
                ))}
                {waypoints.length < 8 && (
                  <button
                    className={`add-waypoint-button ${placementMode === "waypoint" ? "add-waypoint-active" : ""}`}
                    type="button"
                    onClick={() => togglePlacement("waypoint")}
                  >
                    <Plus size={13} /> {placementMode === "waypoint" ? "Placing waypoints" : "Add waypoint"}
                  </button>
                )}
              </>
            )}
          </div>
        )}
        <p className="section-note">Drag any marker on the map to move it. Press Esc to stop placing.</p>
      </div>

      <div className="panel-section">
        <div className="section-kicker"><span>Travel style</span></div>
        <div className="profile-grid" role="radiogroup" aria-label="Travel style">
          {PROFILES.map(({ id, label, detail, icon: Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={profile === id}
              className={`profile-option ${profile === id ? "profile-option-active" : ""}`}
              onClick={() => onProfileChange(id)}
            >
              <Icon size={15} strokeWidth={1.8} />
              <strong>{label}</strong>
              <small>{detail}</small>
            </button>
          ))}
        </div>
        <p className="section-note">Speed is adjusted for the real grade and the way&rsquo;s mapped surface.</p>
      </div>

      <div className="panel-section">
        <div className="section-kicker"><span>Limits</span></div>
        <div className="slider-stack">
          <RangeControl
            label="Steepest grade"
            icon={TrendingUp}
            value={settings.maxGradePercent}
            min={5}
            max={60}
            valueLabel={`${settings.maxGradePercent}%`}
            helpText="No part of the route may be steeper than this"
            onChange={(value) => patch({ maxGradePercent: value })}
          />
          <RangeControl
            label="Longest off-trail stretch"
            icon={MoveHorizontal}
            value={settings.maxOffTrailMeters}
            min={25}
            max={1_000}
            step={25}
            valueLabel={`${settings.maxOffTrailMeters} m`}
            helpText="Cap on any single stretch away from a mapped way"
            onChange={(value) => patch({ maxOffTrailMeters: value })}
          />
          <RangeControl
            label="Off-trail effort"
            icon={CornerUpRight}
            value={settings.offTrailAversion}
            min={1}
            max={5}
            step={0.5}
            valueLabel={`${settings.offTrailAversion.toFixed(1)}×`}
            helpText={settings.offTrailAversion <= 1
              ? "A minute in the open is worth a minute on a trail"
              : `A minute in the open costs like ${settings.offTrailAversion.toFixed(1)} on a trail`}
            onChange={(value) => patch({ offTrailAversion: value })}
          />
        </div>
      </div>

      <div className="panel-section">
        <div className="section-kicker"><span>What is allowed</span></div>
        <div className="toggle-stack">
          <ToggleRow
            label="Cross streets anywhere"
            detail="Off: only cross where OSM maps a crossing"
            checked={settings.allowStreetCrossing}
            icon={CornerUpRight}
            onChange={(value) => patch({ allowStreetCrossing: value })}
          />
          <ToggleRow
            label="Walk along streets"
            detail="Off unless a sidewalk or footway is mapped"
            checked={settings.allowStreetWalking}
            icon={Footprints}
            onChange={(value) => patch({ allowStreetWalking: value })}
          />
          <ToggleRow
            label="Avoid watercourses"
            detail="Refuse ground within 26 m of a mapped stream"
            checked={settings.avoidWater}
            icon={Waves}
            onChange={(value) => patch({ avoidWater: value })}
          />
          <ToggleRow
            label="Offer alternatives"
            detail="Draw a direct and a trail-hugging option too"
            checked={settings.showAlternatives}
            icon={Route}
            onChange={(value) => patch({ showAlternatives: value })}
          />
        </div>
      </div>

      <div className="panel-actions">
        <button className="button button-ghost" type="button" onClick={onReset}>
          <RotateCcw size={13} /> Reset
        </button>
        <span className="panel-actions-note">
          {isCalculating ? "Recalculating" : "Routes update as you change anything"}
        </span>
      </div>
    </aside>
  );
}
