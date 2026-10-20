import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiff, buildIndex, changeBetween, diffColor, fileOffset, formatK, heightForLoc, layoutDistricts, layoutFloors,
  neighborsFor, orderDistrictFiles, searchFiles, summarizeDistrict, symbolNeighbors
} from '../src/derive.js';

const graph = {
  meta: { fileCount: 3 },
  districts: [
    { id: 'managers', name: 'managers', path: 'p/managers', fileCount: 2, loc: 300, defs: 4, classes: 1, fanIn: 2, fanOut: 3, subs: [], files: ['managers/scheduler.py', 'managers/b.py'] },
    { id: 'mem_cache', name: 'mem_cache', path: 'p/mem_cache', fileCount: 1, loc: 100, defs: 1, classes: 0, fanIn: 3, fanOut: 1, subs: [], files: ['mem_cache/memory_pool.py'] }
  ],
  files: [
    { id: 'managers/scheduler.py', path: 'p/managers/scheduler.py', district: 'managers', sub: null, loc: 200, codeLines: 150, defs: 3, classes: 1, fanOut: 2, fanIn: 1, imports: ['mem_cache/memory_pool.py', 'managers/b.py'] },
    { id: 'managers/b.py', path: 'p/managers/b.py', district: 'managers', sub: null, loc: 100, codeLines: 80, defs: 1, classes: 0, fanOut: 1, fanIn: 1, imports: [] },
    { id: 'mem_cache/memory_pool.py', path: 'p/mem_cache/memory_pool.py', district: 'mem_cache', sub: null, loc: 100, codeLines: 90, defs: 1, classes: 0, fanOut: 1, fanIn: 2, imports: ['managers/b.py'] }
  ],
  imports: [
    { from: 'managers/scheduler.py', to: 'mem_cache/memory_pool.py', weight: 2 },
    { from: 'managers/scheduler.py', to: 'managers/b.py', weight: 1 },
    { from: 'mem_cache/memory_pool.py', to: 'managers/b.py', weight: 1 }
  ],
  packageEdges: [
    { from: 'managers', to: 'mem_cache', weight: 2 },
    { from: 'mem_cache', to: 'managers', weight: 1 }
  ],
  topFiles: [], topFanIn: []
};

test('height grows with line count but stays bounded', () => {
  assert.ok(heightForLoc(10, 10000) < heightForLoc(1000, 10000));
  assert.ok(heightForLoc(10000, 10000) <= 3.5 + 1e-9);
  assert.ok(heightForLoc(1, 10000) >= 0.4 - 1e-9);
});

test('district layout never overlaps and keeps every file', () => {
  const index = buildIndex(graph);
  const { plots, bounds } = layoutDistricts(graph.districts, index.filesById);
  assert.equal(plots.length, 2);
  const total = plots.reduce((acc, plot) => acc + plot.files.length, 0);
  assert.equal(total, 3);
  for (const plot of plots) assert.equal(plot.files.length, plot.district.fileCount);
  const [first, second] = plots;
  const apart = Math.abs(first.x - second.x) >= (first.side + second.side) / 2 - 1e-9
    || Math.abs(first.z - second.z) >= (first.depth + second.depth) / 2 - 1e-9;
  assert.ok(apart, '街区不应重叠');
  assert.ok(bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ);
});

test('buildings stay inside their plot bounds', () => {
  const index = buildIndex(graph);
  const { plots } = layoutDistricts(graph.districts, index.filesById);
  for (const plot of plots) {
    plot.files.forEach((_, i) => {
      const { dx, dz } = fileOffset(plot, i);
      assert.ok(Math.abs(dx) <= plot.side / 2 + 1e-9);
      assert.ok(Math.abs(dz) <= plot.depth / 2 + 1e-9);
    });
  }
});

test('neighbors are sorted by weight and respect the limit', () => {
  const index = buildIndex(graph);
  const file = neighborsFor(index, 'file', 'managers/scheduler.py', 1);
  assert.deepEqual(file.out, [{ id: 'mem_cache/memory_pool.py', weight: 2 }]);
  const incoming = neighborsFor(index, 'file', 'managers/b.py', 5).in;
  assert.deepEqual(incoming.map(edge => edge.id), ['managers/scheduler.py', 'mem_cache/memory_pool.py']);
  const district = neighborsFor(index, 'district', 'managers', 5);
  assert.deepEqual(district.out.map(edge => edge.id), ['mem_cache']);
});

test('search ranks bigger files first and ignores empty input', () => {
  assert.deepEqual(searchFiles(graph, ''), []);
  const hits = searchFiles(graph, 'managers/');
  assert.deepEqual(hits.map(file => file.id), ['managers/scheduler.py', 'managers/b.py']);
  assert.equal(formatK(6132), '6.1k');
  assert.equal(formatK(820), '820');
});

test('district files are grouped by sub directory then by size', () => {
  const index = buildIndex({
    ...graph,
    files: [
      { ...graph.files[0], sub: 'b' },
      { ...graph.files[1], sub: 'a' },
    ]
  });
  const order = orderDistrictFiles(graph.districts[0], index.filesById);
  assert.deepEqual(order, ['managers/b.py', 'managers/scheduler.py']);
});

const symbols = [
  { id: 'f.py#b', name: 'b', kind: 'method', start: 60, end: 90, loc: 30, calls: ['a', 'A'] },
  { id: 'f.py#A', name: 'A', kind: 'class', start: 10, end: 50, loc: 40, calls: ['a', 'missing'] },
  { id: 'f.py#a', name: 'a', kind: 'function', start: 30, end: 45, loc: 15, calls: [] }
];

test('symbol floors stack bottom-up and keep the building height', () => {
  const file = { loc: 400, symbols };
  const { floors, totalHeight } = layoutFloors(file, 10000);
  assert.deepEqual(layoutFloors({ loc: 400 }, 10000).floors, []);
  assert.deepEqual(floors.map(floor => floor.name), ['A', 'a', 'b']);
  assert.equal(floors[0].y0, 0);
  assert.equal(totalHeight, heightForLoc(400, 10000));
  assert.ok(Math.abs(floors[floors.length - 1].y1 - totalHeight) < 1e-9);
  assert.ok(floors[0].y0 < floors[1].y0 && floors[1].y0 < floors[2].y0);
  // 层高与 log10(loc) 成正比：log10(31) / log10(16)
  const ratio = floors[2].height / floors[1].height;
  assert.ok(Math.abs(ratio - Math.log10(31) / Math.log10(16)) < 1e-9);
  assert.equal(new Set(floors.map(floor => floor.color)).size, 3);
});

test('symbol neighbors resolve calls by same file symbol name', () => {
  const file = { symbols };
  const incoming = symbolNeighbors(file, 'f.py#a');
  assert.deepEqual(incoming.out, []);
  assert.deepEqual(incoming.in.map(item => item.id), ['f.py#A', 'f.py#b']);
  assert.deepEqual(symbolNeighbors(file, 'f.py#b').out.map(item => item.id), ['f.py#A', 'f.py#a']);
  assert.deepEqual(symbolNeighbors(file, 'f.py#a').in.map(item => item.name), ['A', 'b']);
});

test('change classification covers added/removed/grown/shrunk/stable', () => {
  assert.equal(changeBetween(null, { loc: 10 }), 'added');
  assert.equal(changeBetween({ loc: 10 }, null), 'removed');
  assert.equal(changeBetween({ loc: 10 }, { loc: 20 }), 'grown');
  assert.equal(changeBetween({ loc: 20 }, { loc: 10 }), 'shrunk');
  // 行数不变时依次看符号数、被依赖数
  assert.equal(changeBetween({ loc: 10, symbols: [] }, { loc: 10, symbols: [{}] }), 'grown');
  assert.equal(changeBetween({ loc: 10, symbols: [{}] }, { loc: 10, symbols: [] }), 'shrunk');
  assert.equal(changeBetween({ loc: 10, fanIn: 1 }, { loc: 10, fanIn: 0 }), 'shrunk');
  assert.equal(changeBetween({ loc: 10, fanIn: 1 }, { loc: 10, fanIn: 1 }), 'stable');
  assert.deepEqual(
    ['added', 'removed', 'grown', 'shrunk', 'stable'].map(diffColor),
    ['#6ee7a8', '#f87171', '#f6a04d', '#6aa6ff', '#7f8ea8']
  );
});

const before = {
  meta: { locTotal: 700, edgeCount: 4, symbolTotal: 2 },
  files: [
    { id: 'g1.py', district: 'x', loc: 100, fanIn: 1, symbols: [] },
    { id: 'g2.py', district: 'x', loc: 100, fanIn: 1, symbols: [] },
    { id: 's1.py', district: 'y', loc: 200, fanIn: 1, symbols: [] },
    { id: 's2.py', district: 'y', loc: 300, fanIn: 1, symbols: [] },
    { id: 'gone.py', district: 'y', loc: 90, fanIn: 1, symbols: [] }
  ],
  imports: [{}, {}, {}, {}]
};

const after = {
  meta: { locTotal: 650, edgeCount: 3, symbolTotal: 5 },
  files: [
    { id: 'g1.py', district: 'x', loc: 300, fanIn: 1, symbols: [] },
    { id: 'g2.py', district: 'x', loc: 250, fanIn: 1, symbols: [] },
    { id: 's1.py', district: 'y', loc: 50, fanIn: 1, symbols: [] },
    { id: 's2.py', district: 'y', loc: 50, fanIn: 1, symbols: [] },
    { id: 'fresh.py', district: 'y', loc: 120, fanIn: 1, symbols: [] }
  ],
  imports: [{}, {}, {}]
};

test('buildDiff counts changes, compares totals and orders the four boards', () => {
  const diff = buildDiff(after, before);
  assert.ok(diff);
  assert.deepEqual(diff.stats.counts, { added: 1, removed: 1, grown: 2, shrunk: 2, stable: 0 });
  assert.deepEqual(diff.boards.grown.map(entry => entry.id), ['g1.py', 'g2.py']);
  assert.deepEqual(diff.boards.shrunk.map(entry => entry.id), ['s2.py', 's1.py']);
  assert.deepEqual(diff.boards.added.map(entry => entry.id), ['fresh.py']);
  assert.deepEqual(diff.boards.removed.map(entry => entry.id), ['gone.py']);
  assert.equal(diff.entries.get('g1.py').loc.delta, 200);
  assert.equal(diff.entries.get('gone.py').loc.new, null);
  assert.equal(diff.entries.get('gone.py').loc.old, 90);
  assert.equal(diff.entries.get('fresh.py').change, 'added');
  // 总量来自 meta，缺基线时不产出对比
  assert.deepEqual(diff.stats.locTotal, { old: 700, new: 650, delta: -50 });
  assert.deepEqual(diff.stats.fileCount, { old: 5, new: 5, delta: 0 });
  assert.deepEqual(diff.stats.edgeCount, { old: 4, new: 3, delta: -1 });
  assert.equal(buildDiff(after, null), null);
});

test('summarizeDistrict counts each change within a district', () => {
  const diff = buildDiff(after, before);
  assert.deepEqual(summarizeDistrict(diff, 'x'), { added: 0, removed: 0, grown: 2, shrunk: 0, stable: 0 });
  assert.deepEqual(summarizeDistrict(diff, 'y'), { added: 1, removed: 1, grown: 0, shrunk: 2, stable: 0 });
  assert.deepEqual(summarizeDistrict(null, 'x'), { added: 0, removed: 0, grown: 0, shrunk: 0, stable: 0 });
});
