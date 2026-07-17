/**
 * Visual style presets for the node graph.
 *
 * Each preset is a self-contained theme describing how nodes, links, labels and
 * the background are drawn on the canvas. Users pick a style from the toolbar;
 * the renderer reads these values every frame. The looks are inspired by a range
 * of well-loved graph visualizations, but the presets stand on their own and are
 * named for the aesthetic they produce, not their inspiration.
 */

const shared = {
  linkWidth: 1,
  nodeMinRadius: 4,
  nodeMaxRadius: 22,
  labelFont: '12px Inter, sans-serif',
  showLabelsAtZoom: 0.75
};

export const GRAPH_STYLES = {
  constellation: {
    id: 'constellation',
    name: 'Constellation',
    description: 'Dark field of glowing nodes with faint links. Sizes scale with connections.',
    ...shared,
    background: '#0a0f1c',
    grid: null,
    link: { color: 'rgba(120,140,180,0.28)', width: 1 },
    linkHighlight: '#7dd3fc',
    node: { glow: 14, stroke: 'rgba(255,255,255,0.85)', strokeWidth: 1.2 },
    palette: ['#7dd3fc', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa'],
    label: { color: '#cbd5e1', halo: '#0a0f1c' },
    selectedRing: '#f8fafc'
  },

  blueprint: {
    id: 'blueprint',
    name: 'Blueprint',
    description: 'Technical schematic look — cyan lines over a fine grid.',
    ...shared,
    background: '#0b1f2a',
    grid: { color: 'rgba(56,189,248,0.10)', size: 28 },
    link: { color: 'rgba(56,189,248,0.45)', width: 1 },
    linkHighlight: '#e0f2fe',
    node: { glow: 0, stroke: '#38bdf8', strokeWidth: 1.5, square: true },
    palette: ['#38bdf8', '#22d3ee', '#67e8f9', '#0ea5e9', '#7dd3fc'],
    label: { color: '#bae6fd', halo: '#0b1f2a' },
    selectedRing: '#e0f2fe'
  },

  aurora: {
    id: 'aurora',
    name: 'Aurora',
    description: 'Soft gradient pastels on deep indigo — calm and readable.',
    ...shared,
    background: '#11142b',
    grid: null,
    link: { color: 'rgba(167,139,250,0.30)', width: 1.2 },
    linkHighlight: '#c4b5fd',
    node: { glow: 18, stroke: 'rgba(255,255,255,0.65)', strokeWidth: 1 },
    palette: ['#c4b5fd', '#f9a8d4', '#a5f3fc', '#fca5a5', '#fcd34d', '#86efac'],
    label: { color: '#e2e8f0', halo: '#11142b' },
    selectedRing: '#ffffff'
  },

  neon: {
    id: 'neon',
    name: 'Neon',
    description: 'High-contrast vivid nodes with bright links for dense graphs.',
    ...shared,
    background: '#050510',
    grid: null,
    link: { color: 'rgba(236,72,153,0.35)', width: 1 },
    linkHighlight: '#f0abfc',
    node: { glow: 22, stroke: '#ffffff', strokeWidth: 1.2 },
    palette: ['#f0abfc', '#22d3ee', '#a3e635', '#fb7185', '#facc15', '#818cf8'],
    label: { color: '#f5f3ff', halo: '#050510' },
    selectedRing: '#ffffff'
  },

  circuit: {
    id: 'circuit',
    name: 'Circuit',
    description: 'Industrial terminal aesthetic — phosphor green on near-black.',
    ...shared,
    background: '#04120a',
    grid: { color: 'rgba(34,197,94,0.10)', size: 24 },
    link: { color: 'rgba(74,222,128,0.35)', width: 1 },
    linkHighlight: '#bbf7d0',
    node: { glow: 8, stroke: '#4ade80', strokeWidth: 1.4, square: true },
    palette: ['#4ade80', '#22c55e', '#a3e635', '#86efac', '#65a30d'],
    label: { color: '#bbf7d0', halo: '#04120a' },
    selectedRing: '#dcfce7'
  },

  slate: {
    id: 'slate',
    name: 'Slate',
    description: 'Minimal light theme — grayscale nodes, subtle links, print-friendly.',
    ...shared,
    background: '#f8fafc',
    grid: { color: 'rgba(15,23,42,0.05)', size: 28 },
    link: { color: 'rgba(71,85,105,0.35)', width: 1 },
    linkHighlight: '#0ea5e9',
    node: { glow: 0, stroke: '#334155', strokeWidth: 1.2 },
    palette: ['#0ea5e9', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'],
    label: { color: '#334155', halo: '#f8fafc' },
    selectedRing: '#0f172a'
  }
};

export const STYLE_LIST = Object.values(GRAPH_STYLES);
export const DEFAULT_STYLE = 'constellation';

// Layout presets. `mode` selects the positioning strategy; the force fields
// (charge/linkDistance/gravity) tune the three free-form force layouts.
export const LAYOUTS = {
  organic: { id: 'organic', name: 'Organic', mode: 'force', charge: -220, linkDistance: 55, gravity: 0.05 },
  spacious: { id: 'spacious', name: 'Spacious', mode: 'force', charge: -520, linkDistance: 110, gravity: 0.03 },
  tight: { id: 'tight', name: 'Tight', mode: 'force', charge: -120, linkDistance: 34, gravity: 0.09 },
  radial: { id: 'radial', name: 'Radial', mode: 'radial', charge: -160, linkDistance: 50, ringGap: 120 },
  tree: { id: 'tree', name: 'Tree', mode: 'tree', rowGap: 34, colGap: 46 },
  cluster: { id: 'cluster', name: 'Cluster', mode: 'cluster', charge: -90, linkDistance: 40, clusterRadius: 260 }
};

export const LAYOUT_LIST = Object.values(LAYOUTS);
export const DEFAULT_LAYOUT = 'organic';
