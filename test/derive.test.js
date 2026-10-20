import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIndex, fileOffset, formatK, heightForLoc, layoutDistricts, neighborsFor, orderDistrictFiles, searchFiles
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
