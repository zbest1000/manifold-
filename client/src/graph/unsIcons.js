'use strict';

/**
 * UNS node icon registry — maps namespace nodes to Lucide icons (plus
 * user-defined custom SVG icons) and rasterizes them for the canvas renderer.
 *
 * Resolution order for a node's icon:
 *   1. Manual override (user picked an icon for that exact path; persisted)
 *   2. Keyword match on the node's own name (pump → droplets, oven → flame, …)
 *   3. Level default (namespace / business unit / site / area / line / cell)
 *
 * Icon data comes from three sources, checked in order when rasterizing:
 *   1. Custom icons (user-uploaded single-path SVGs, stored server-side,
 *      fetched once via /api/uns/icons)
 *   2. The curated industrial subset (~130 icons, tree-shaken named imports —
 *      bundled synchronously, no 700 KB chunk)
 *   3. The full Lucide library — an explicit opt-in via loadFullLibrary()
 *      (dynamic import of `lucide`, its own lazy chunk, cached)
 * Unknown names fall through to the renderer's built-in geometric glyphs, so
 * nothing ever blocks on icon data.
 */

import { api } from '@/lib/api';
import { CURATED_ICONS, curatedIconNames } from './curatedIcons';

export { curatedIconNames };

const OVERRIDES_KEY = 'tc.unsIconOverrides';

// ---- custom icons (server-side, single-path SVGs) ---------------------------
let customPromise = null;
const customIcons = new Map(); // name -> { id, name, svgPath, node: IconNode }

function registerCustom(icon) {
  customIcons.set(icon.name, { ...icon, node: [['path', { d: icon.svgPath }]] });
  invalidateRaster(icon.name);
}

/** Fetch user-defined icons once (cached). Safe to call repeatedly. */
export function loadCustomIcons() {
  if (!customPromise) {
    customPromise = api
      .listUnsIcons()
      .then(({ icons }) => {
        for (const icon of icons || []) registerCustom(icon);
        return customIconList();
      })
      .catch(() => customIconList()); // offline/unauthed: just no custom icons
  }
  return customPromise;
}

/** User-defined icons as [{ id, name, svgPath }], for the picker. */
export function customIconList() {
  return [...customIcons.values()].map(({ id, name, svgPath }) => ({ id, name, svgPath }));
}

/** Upsert a custom icon via the API and register it locally. */
export async function saveCustomIcon(name, svgPath) {
  const icon = await api.saveUnsIcon({ name, svgPath });
  registerCustom(icon);
  return icon;
}

/** Delete a custom icon via the API and drop it locally. */
export async function deleteCustomIcon(name) {
  const icon = customIcons.get(name);
  if (!icon) return;
  await api.deleteUnsIcon(icon.id);
  customIcons.delete(name);
  invalidateRaster(name);
}

// ---- full lucide library (explicit lazy opt-in) ------------------------------
let fullPromise = null;
let fullIcons = null; // { PascalName: IconNode }

/** Dynamic-import the full ~2,000-icon Lucide set (its own chunk). Cached. */
export function loadFullLibrary() {
  if (!fullPromise) {
    fullPromise = import('lucide').then((m) => {
      fullIcons = m.icons || {};
      return fullIcons;
    });
  }
  return fullPromise;
}

export function fullLibraryLoaded() {
  return Boolean(fullIcons);
}

/**
 * Warm the icon registry. The curated set is bundled synchronously, so this
 * only kicks off the (cheap) custom-icon fetch; it no longer pulls the 700 KB
 * Lucide chunk. Kept as the entry point UnsTopology/pickers already call.
 */
export function loadIcons() {
  return loadCustomIcons();
}

/** The default icon sources are bundled — always ready. */
export function iconsLoaded() {
  return true;
}

/** All available icon names (kebab-case), for the picker. */
export function allIconNames() {
  const names = new Set(customIcons.keys());
  for (const n of CURATED_ICONS.keys()) names.add(n);
  if (fullIcons) for (const k of Object.keys(fullIcons)) names.add(pascalToKebab(k));
  return [...names];
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
// Every icon named here is in the curated set, so automatic mapping renders
// without loading the full library.
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

function invalidateRaster(name) {
  for (const key of imageCache.keys()) {
    if (key.startsWith(`${name}|`)) imageCache.delete(key);
  }
}

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

/** IconNode for a name: custom → curated → full-library-if-loaded → null. */
function resolveIconNode(name) {
  const custom = customIcons.get(name);
  if (custom) return custom.node;
  const curated = CURATED_ICONS.get(name);
  if (curated) return curated;
  if (fullIcons) return fullIcons[kebabToPascal(name)] || null;
  return null;
}

/**
 * Cached raster for an icon. Returns an Image that MAY still be loading
 * (check .complete); returns null when the name is unknown to every loaded
 * source — callers draw their fallback glyph in both cases.
 */
export function getIconImage(name, color, size = 40) {
  const key = `${name}|${color}|${size}`;
  let img = imageCache.get(key);
  if (img) return img;
  const iconNode = resolveIconNode(name);
  if (!iconNode) return null;
  img = new Image(size, size);
  img.src = `data:image/svg+xml;utf8,${encodeURIComponent(iconNodeToSvg(iconNode, color, size))}`;
  imageCache.set(key, img);
  return img;
}
