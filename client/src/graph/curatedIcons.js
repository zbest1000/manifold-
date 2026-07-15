'use strict';

/**
 * Curated industrial icon subset — the icons a UNS actually uses, imported
 * INDIVIDUALLY from `lucide` so Vite/Rollup tree-shakes the bundle down to
 * just these IconNode arrays (lucide's root export re-exports one module per
 * icon and is marked sideEffects: false, so named imports keep only what we
 * list here — ~130 icons instead of the ~2,000-icon 712 KB chunk).
 *
 * Keys are kebab-case lucide names, matching what the picker persists and the
 * renderer resolves. Every name referenced by unsIcons.js's KEYWORD_ICONS and
 * LEVEL_ICONS tables is included, so automatic mapping never needs the full
 * library. The full set stays available via unsIcons.loadFullLibrary().
 */

import {
  // Facilities & structure
  Factory, Warehouse, Building, Building2, Network, LayoutGrid, Rows3, Component, CircleDot,
  // Mechanical & maintenance
  Cog, Settings, Wrench, Hammer, HardHat, Construction,
  // Measurement & time
  Gauge, CircleGauge, Thermometer, Weight, Scale, Timer, Clock, Calendar, Activity, AudioWaveform, Waves, Hash,
  // Fluids, air & heat
  Droplet, Droplets, Wind, Fan, Flame, Snowflake, Sun, Cloud, Heater, AirVent, Pipette, Cylinder,
  // Power & energy
  Zap, Plug, PlugZap, Battery, BatteryCharging, Fuel, Power,
  // Compute & connectivity
  Cpu, CircuitBoard, Microchip, Server, Database, HardDrive, Radio, RadioTower, Wifi,
  Antenna, Router, SatelliteDish, Cable, Barcode,
  // Robotics, logistics & transport
  Bot, MoveHorizontal, Truck, Forklift, Ship, Package, Boxes, Container,
  // Lab & quality
  FlaskConical, Beaker, TestTube, Microscope, BadgeCheck, Radiation, Recycle,
  // Pipelines & flow
  GitBranch, GitMerge, Workflow, Filter, Target,
  // Safety & security
  Siren, Bell, AlarmClock, Shield, ShieldCheck, ShieldAlert, Lock, Eye, Camera, ScanLine, FireExtinguisher,
  // Location & layout
  MapPin, Layers, Grid3x3,
  // Charts & trends
  ChartLine, ChartColumn, ChartBar, ChartPie, TrendingUp, TrendingDown, BarChart3,
  // Arrows & actions
  ArrowUp, ArrowDown, ArrowLeft, ArrowRight, ArrowUpDown, ArrowLeftRight, RefreshCw,
  SlidersHorizontal, SlidersVertical,
  // Organization & documents
  Tag, Bookmark, Folder, FileText, Clipboard, ClipboardList, Briefcase, Blocks, Users,
  // Status & flags
  Check, CircleCheck, X, CircleX, TriangleAlert, CircleAlert, OctagonAlert, Info,
  // Misc plant floor
  Lightbulb, DoorOpen, Printer, Stamp, Blend
} from 'lucide';

/** kebab-case lucide name → IconNode ([[tag, attrs], ...]) */
export const CURATED_ICONS = new Map([
  ['factory', Factory], ['warehouse', Warehouse], ['building', Building], ['building-2', Building2],
  ['network', Network], ['layout-grid', LayoutGrid], ['rows-3', Rows3],
  ['component', Component], ['circle-dot', CircleDot],

  ['cog', Cog], ['settings', Settings], ['wrench', Wrench], ['hammer', Hammer], ['hard-hat', HardHat],
  ['construction', Construction],

  ['gauge', Gauge], ['circle-gauge', CircleGauge], ['thermometer', Thermometer], ['weight', Weight],
  ['scale', Scale], ['timer', Timer], ['clock', Clock], ['calendar', Calendar],
  ['activity', Activity], ['audio-waveform', AudioWaveform], ['waves', Waves], ['hash', Hash],

  ['droplet', Droplet], ['droplets', Droplets], ['wind', Wind], ['fan', Fan], ['flame', Flame],
  ['snowflake', Snowflake], ['sun', Sun], ['cloud', Cloud], ['heater', Heater], ['air-vent', AirVent],
  ['pipette', Pipette], ['cylinder', Cylinder],

  ['zap', Zap], ['plug', Plug], ['plug-zap', PlugZap],
  ['battery', Battery], ['battery-charging', BatteryCharging],
  ['fuel', Fuel], ['power', Power],

  ['cpu', Cpu], ['circuit-board', CircuitBoard], ['microchip', Microchip],
  ['server', Server], ['database', Database], ['hard-drive', HardDrive], ['radio', Radio],
  ['radio-tower', RadioTower], ['wifi', Wifi], ['antenna', Antenna], ['router', Router],
  ['satellite-dish', SatelliteDish], ['cable', Cable], ['barcode', Barcode],

  ['bot', Bot], ['move-horizontal', MoveHorizontal], ['truck', Truck], ['forklift', Forklift],
  ['ship', Ship], ['package', Package], ['boxes', Boxes], ['container', Container],

  ['flask-conical', FlaskConical], ['beaker', Beaker], ['test-tube', TestTube],
  ['microscope', Microscope], ['badge-check', BadgeCheck], ['radiation', Radiation], ['recycle', Recycle],

  ['git-branch', GitBranch], ['git-merge', GitMerge], ['workflow', Workflow], ['filter', Filter],
  ['target', Target],

  ['siren', Siren], ['bell', Bell], ['alarm-clock', AlarmClock],
  ['shield', Shield], ['shield-check', ShieldCheck], ['shield-alert', ShieldAlert], ['lock', Lock],
  ['eye', Eye], ['camera', Camera], ['scan-line', ScanLine], ['fire-extinguisher', FireExtinguisher],

  ['map-pin', MapPin], ['layers', Layers], ['grid-3x3', Grid3x3],

  ['chart-line', ChartLine], ['chart-column', ChartColumn], ['chart-bar', ChartBar],
  ['chart-pie', ChartPie], ['trending-up', TrendingUp], ['trending-down', TrendingDown],
  ['bar-chart-3', BarChart3],

  ['arrow-up', ArrowUp], ['arrow-down', ArrowDown], ['arrow-left', ArrowLeft], ['arrow-right', ArrowRight],
  ['arrow-up-down', ArrowUpDown], ['arrow-left-right', ArrowLeftRight], ['refresh-cw', RefreshCw],
  ['sliders-horizontal', SlidersHorizontal], ['sliders-vertical', SlidersVertical],

  ['tag', Tag], ['bookmark', Bookmark], ['folder', Folder], ['file-text', FileText],
  ['clipboard', Clipboard], ['clipboard-list', ClipboardList], ['briefcase', Briefcase],
  ['blocks', Blocks], ['users', Users],

  ['check', Check], ['circle-check', CircleCheck], ['x', X], ['circle-x', CircleX],
  ['triangle-alert', TriangleAlert], ['circle-alert', CircleAlert], ['octagon-alert', OctagonAlert],
  ['info', Info],

  ['lightbulb', Lightbulb], ['door-open', DoorOpen], ['printer', Printer],
  ['stamp', Stamp], ['blend', Blend]
]);

export function curatedIconNames() {
  return [...CURATED_ICONS.keys()];
}
