import { describe, it, expect, vi } from 'vitest';

// UnsTopology pulls in the store, which pulls in the shared socket — stub it so
// importing the module doesn't open a network connection from the test runner.
vi.mock('@/lib/socket', () => ({
  socket: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn() },
  reconnectSocket: vi.fn()
}));
// react-hot-toast injects styles via goober, which needs `document`.
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null
}));

const { buildUnsTree, levelName, DEFAULT_LEVELS } = await import('@/graph/UnsTopology');

const broker = { id: 'bk1', name: 'plant broker', host: 'h', port: 1883 };

describe('buildUnsTree', () => {
  it('builds a namespace tree with per-branch topic counts', () => {
    const root = buildUnsTree(broker, [
      { topic: 'site/area/line/temp' },
      { topic: 'site/area/line/press' },
      { topic: 'site/area2/state' }
    ]);
    expect(root.name).toBe('plant broker');
    expect(root.topicCount).toBe(3);
    const site = root.children.get('site');
    expect(site.topicCount).toBe(3);
    expect(site.depth).toBe(1);
    const area = site.children.get('area');
    expect(area.topicCount).toBe(2);
    const line = area.children.get('line');
    expect([...line.children.keys()].sort()).toEqual(['press', 'temp']);
    expect(line.children.get('temp').path).toBe('site/area/line/temp');
  });

  it('skips $SYS and other $-topics — broker plumbing is not namespace', () => {
    const root = buildUnsTree(broker, [{ topic: '$SYS/broker/uptime' }, { topic: 'real/topic' }]);
    expect(root.children.has('$SYS')).toBe(false);
    expect(root.topicCount).toBe(1);
  });

  it('normalizes empty segments (a//b) instead of creating blank nodes', () => {
    const root = buildUnsTree(broker, [{ topic: 'a//b' }]);
    const a = root.children.get('a');
    expect(a.children.has('')).toBe(false);
    expect(a.children.has('b')).toBe(true);
  });
});

describe('levelName', () => {
  it('maps depth to the ladder and clamps past the end', () => {
    expect(levelName(0)).toBe(DEFAULT_LEVELS[0]);
    expect(levelName(2)).toBe(DEFAULT_LEVELS[2]);
    expect(levelName(99)).toBe(DEFAULT_LEVELS[DEFAULT_LEVELS.length - 1]);
  });

  it('respects a custom ladder', () => {
    expect(levelName(1, ['Root', 'Custom'])).toBe('Custom');
    expect(levelName(5, ['Root', 'Custom'])).toBe('Custom');
  });
});
