'use strict';

/**
 * UNS node icon registry — maps namespace nodes to any of the ~2,000 Lucide
 * icons and rasterizes them for the canvas renderer.
 *
 * Resolution order for a node's icon:
 *   1. Manual override (user picked an icon for that exact path; persisted)
 *   2. Keyword match on the node's own name (pump → droplets, oven → flame, …)
 *   3. Level default (namespace / business unit / site / area / line / cell)
 *
 * The full icon set is loaded lazily (dynamic import of `lucide`, its own
 * chunk) the first time a UNS surface needs it, so the main bundle stays lean.
 * Icons are drawn onto the canvas via cached rasterized Images keyed by
 * (name, color, size); until an image is ready the renderer falls back to its
 * built-in geometric glyphs, so nothing ever blocks on the icon chunk.
 */

const OVERRIDES_KEY = 'tc.unsIconOverrides';

// ---- lazy lucide icon data --------------------------------------------------
let lucidePromise = null;
let lucideIcons = null; // { PascalName: IconNode }

export function loadIcons() {
  if (!lucidePromise) {
    lucidePromise = import('lucide').then((m) => {
      lucideIcons = m.icons || {};
      return lucideIcons;
    });
  }
  return lucidePromise;
}

export function iconsLoaded() {
  return Boolean(lucideIcons);
}

/** All available icon names (kebab-case), for the picker. Empty until loaded. */
export function allIconNames() {
  if (!lucideIcons) return [];
  return Object.keys(lucideIcons).map(pascalToKebab);
}

function pascalToKebab(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function kebabToPascal(s) {
  return s.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
}

// ---- mapping ---------------------------------------------------------------

// Per-level defaults (by namespace depth).
export const LEVEL_ICONS = ['network', 'building-2', 'factory', 'layout-grid', 'rows-3', 'component', 'circle-dot'];

// Name-keyword → icon. First match wins; checked against the node's own name.
// Industrial-leaning, deliberately broad — manual overrides cover the rest.
const KEYWORD_ICONS = [
  ['temp', 'thermometer'],
  ['therm', 'thermometer'],
  ['pressure', 'gauge'],
  ['humid', 'droplets'],
  ['water', 'droplet'],
  ['pump', 'droplets'],
  ['valve', 'sliders-horizontal'],
  ['flow', 'waves'],
  ['steam', 'cloud'],
  ['boiler', 'flame'],
  ['oven', 'flame'],
  ['fryer', 'flame'],
  ['furnace', 'flame'],
  ['heat', 'flame'],
  ['cool', 'snowflake'],
  ['chill', 'snowflake'],
  ['freez', 'snowflake'],
  ['hvac', 'fan'],
  ['fan', 'fan'],
  ['air', 'wind'],
  ['power', 'zap'],
  ['energy', 'zap'],
  ['kwh', 'zap'],
  ['electr', 'zap'],
  ['battery', 'battery-charging'],
  ['fuel', 'fuel'],
  ['gas', 'fuel'],
  ['motor', 'cog'],
  ['drive', 'cog'],
  ['gear', 'cog'],
  ['rpm', 'circle-gauge'],
  ['speed', 'circle-gauge'],
  ['torque', 'circle-gauge'],
  ['vibrat', 'audio-waveform'],
  ['press', 'stamp'],
  ['mixer', 'blend'],
  ['robot', 'bot'],
  ['conveyor', 'move-horizontal'],
  ['filler', 'pipette'],
  ['capper', 'circle-check'],
  ['washer', 'droplets'],
  ['packag', 'package'],
  ['pallet', 'boxes'],
  ['dock', 'container'],
  ['warehouse', 'warehouse'],
  ['logisti', 'truck'],
  ['ship', 'truck'],
  ['tank', 'database'],
  ['silo', 'database'],
  ['level', 'bar-chart-3'],
  ['weight', 'weight'],
  ['scale', 'weight'],
  ['count', 'hash'],
  ['quality', 'badge-check'],
  ['lab', 'flask-conical'],
  ['test', 'test-tube'],
  ['ph', 'flask-conical'],
  ['viscosity', 'beaker'],
  ['maint', 'wrench'],
  ['repair', 'wrench'],
  ['backlog', 'clipboard-list'],
  ['alarm', 'siren'],
  ['alert', 'triangle-alert'],
  ['safety', 'shield-check'],
  ['kpi', 'chart-line'],
  ['oee', 'chart-line'],
  ['report', 'chart-column'],
  ['erp', 'briefcase'],
  ['order', 'clipboard-list'],
  ['inventory', 'boxes'],
  ['production', 'factory'],
  ['assembly', 'blocks'],
  ['machine', 'cog'],
  ['plc', 'cpu'],
  ['sensor', 'radio'],
  ['camera', 'camera'],
  ['scan', 'scan-line'],
  ['print', 'printer'],
  ['light', 'lightbulb'],
  ['door', 'door-open'],
  ['utilit', 'plug-zap']
];

function loadOverrides() {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}');
  } catch {
    return {};
  }
}

let overrides = loadOverrides();

export function setIconOverride(brokerId, path, iconName) {
  const key = `${brokerId}:${path}`;
  if (iconName) overrides[key] = iconName;
  else delete overrides[key];
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

export function getIconOverride(brokerId, path) {
  return overrides[`${brokerId}:${path}`] || null;
}

/** Resolve the icon name (kebab-case) for a UNS node. Always returns a name. */
export function resolveIconName(node) {
  const manual = overrides[`${node.brokerId}:${node.path}`];
  if (manual) return manual;
  const lower = node.name.toLowerCase();
  for (const [kw, icon] of KEYWORD_ICONS) {
    if (lower.includes(kw)) return icon;
  }
  return LEVEL_ICONS[Math.min(node.depth, LEVEL_ICONS.length - 1)];
}

// ---- canvas rasterization ----------------------------------------------------
const imageCache = new Map(); // `${name}|${color}|${size}` -> HTMLImageElement (complete or loading)

function iconNodeToSvg(iconNode, color, size) {
  const children = iconNode
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`
  );
}

/**
 * Cached raster for an icon. Returns an Image that MAY still be loading
 * (check .complete); returns null when the icon set isn't loaded yet or the
 * name is unknown — callers draw their fallback glyph in both cases.
 */
export function getIconImage(name, color, size = 40) {
  if (!lucideIcons) {
    loadIcons();
    return null;
  }
  const key = `${name}|${color}|${size}`;
  let img = imageCache.get(key);
  if (img) return img;
  const iconNode = lucideIcons[kebabToPascal(name)];
  if (!iconNode) return null;
  img = new Image(size, size);
  img.src = `data:image/svg+xml;utf8,${encodeURIComponent(iconNodeToSvg(iconNode, color, size))}`;
  imageCache.set(key, img);
  return img;
}
