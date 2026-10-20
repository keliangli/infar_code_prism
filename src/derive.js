// 纯逻辑层：布局、配色、指标格式与依赖邻居提取。
// 刻意不依赖 three，便于 node --test 直接单测。
export const FILE_FOOTPRINT = 0.62;   // 建筑底面边长
export const FILE_GAP = 0.16;
export const PLOT_PADDING = 1.0;      // 街区四周留白
export const PLOT_GAP = 1.9;          // 街区之间间距
export const ROW_WIDTH = 46;          // 每行街区的最大宽度（世界单位）

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

export function formatK(value) {
  const n = Number(value || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

// 高度：按行数取对数映射，避免 scheduler.py 这类超大文件把其余建筑压成平地。
export function heightForLoc(loc, maxLoc) {
  const t = Math.log10(Math.max(1, loc) + 1) / Math.log10(Math.max(2, maxLoc) + 1);
  return 0.4 + 3.1 * clamp(t, 0, 1);
}

// 街区配色：黄金角步进，保证相邻街区色相不相近。
export function districtColor(index) {
  return `hsl(${Math.round((index * 137.508) % 360)}, 62%, 58%)`;
}

// 热度配色：蓝（冷）→ 橙红（热），用于“被依赖程度”。
export function heatColor(ratio) {
  const t = clamp(ratio, 0, 1);
  const hue = 205 - 180 * t;
  const light = 56 + 8 * t;
  return `hsl(${hue.toFixed(0)}, 78%, ${light.toFixed(0)}%)`;
}

// 街区内的建筑排序：先按二级目录分组，再按行数降序，让同一子目录的楼连成一片。
export function orderDistrictFiles(district, filesById) {
  return [...district.files].sort((a, b) => {
    const fa = filesById.get(a), fb = filesById.get(b);
    const sa = fa?.sub || '', sb = fb?.sub || '';
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (fb?.loc || 0) - (fa?.loc || 0);
  });
}

// 街区在平面上的摆放：按体量降序做行式装箱，避免出现难以辨认的碎片排布。
export function layoutDistricts(districts, filesById) {
  const ordered = [...districts].sort((a, b) => b.loc - a.loc);
  const plots = [];
  let cursorX = 0, cursorZ = 0, rowDepth = 0;
  for (const district of ordered) {
    const files = orderDistrictFiles(district, filesById);
    const cols = Math.max(1, Math.ceil(Math.sqrt(files.length)));
    const rows = Math.max(1, Math.ceil(files.length / cols));
    const side = PLOT_PADDING * 2 + FILE_FOOTPRINT * cols + FILE_GAP * (cols - 1);
    const depth = PLOT_PADDING * 2 + FILE_FOOTPRINT * rows + FILE_GAP * (rows - 1);
    if (cursorX > 0 && cursorX + side > ROW_WIDTH) {
      cursorX = 0;
      cursorZ += rowDepth + PLOT_GAP;
      rowDepth = 0;
    }
    plots.push({
      id: district.id, district, files, cols, rows, side, depth,
      x: cursorX + side / 2, z: cursorZ + depth / 2
    });
    cursorX += side + PLOT_GAP;
    rowDepth = Math.max(rowDepth, depth);
  }
  const bounds = plots.reduce((acc, plot) => ({
    minX: Math.min(acc.minX, plot.x - plot.side / 2), maxX: Math.max(acc.maxX, plot.x + plot.side / 2),
    minZ: Math.min(acc.minZ, plot.z - plot.depth / 2), maxZ: Math.max(acc.maxZ, plot.z + plot.depth / 2)
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  return { plots, bounds };
}

// 单个建筑的平面坐标（相对街区中心的偏移）。
export function fileOffset(plot, index) {
  const { cols } = plot;
  const col = index % cols, row = Math.floor(index / cols);
  const width = FILE_FOOTPRINT * cols + FILE_GAP * (cols - 1);
  const depth = FILE_FOOTPRINT * plot.rows + FILE_GAP * (plot.rows - 1);
  return {
    dx: -width / 2 + FILE_FOOTPRINT / 2 + col * (FILE_FOOTPRINT + FILE_GAP),
    dz: -depth / 2 + FILE_FOOTPRINT / 2 + row * (FILE_FOOTPRINT + FILE_GAP)
  };
}

// 依赖索引：把 import 边整理成可查询的出边/入边表。
export function buildIndex(graph) {
  const filesById = new Map(graph.files.map(file => [file.id, file]));
  const districtById = new Map(graph.districts.map(district => [district.id, district]));
  const outMap = new Map(), inMap = new Map();
  for (const edge of graph.imports) {
    if (!outMap.has(edge.from)) outMap.set(edge.from, []);
    outMap.get(edge.from).push({ id: edge.to, weight: edge.weight });
    if (!inMap.has(edge.to)) inMap.set(edge.to, []);
    inMap.get(edge.to).push({ id: edge.from, weight: edge.weight });
  }
  const districtOut = new Map(), districtIn = new Map();
  for (const edge of graph.packageEdges) {
    if (!districtOut.has(edge.from)) districtOut.set(edge.from, []);
    districtOut.get(edge.from).push({ id: edge.to, weight: edge.weight });
    if (!districtIn.has(edge.to)) districtIn.set(edge.to, []);
    districtIn.get(edge.to).push({ id: edge.from, weight: edge.weight });
  }
  const sortEdges = list => (list || []).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));
  for (const [key, list] of outMap) outMap.set(key, sortEdges(list));
  for (const [key, list] of inMap) inMap.set(key, sortEdges(list));
  for (const [key, list] of districtOut) districtOut.set(key, sortEdges(list));
  for (const [key, list] of districtIn) districtIn.set(key, sortEdges(list));
  const maxLoc = graph.files.reduce((acc, file) => Math.max(acc, file.loc), 0);
  const maxFanIn = graph.files.reduce((acc, file) => Math.max(acc, file.fanIn), 0);
  return { graph, filesById, districtById, outMap, inMap, districtOut, districtIn, maxLoc, maxFanIn };
}

// 取某个节点的前 limit 条出边/入边。
export function neighborsFor(index, kind, id, limit = 10) {
  const [outMap, inMap] = kind === 'district' ? [index.districtOut, index.districtIn] : [index.outMap, index.inMap];
  return { out: (outMap.get(id) || []).slice(0, limit), in: (inMap.get(id) || []).slice(0, limit) };
}

// 文件内部的符号配色：类 / 函数 / 方法三色，刻意与依赖连线的青、紫区分开。
export const SYMBOL_COLORS = { class: '#f2b661', function: '#7fd8a5', method: '#8fa9ff' };

export function symbolColor(kind) {
  return SYMBOL_COLORS[kind] || '#8fa8d8';
}

// 符号顺序：自下而上按起始行升序，同起点时用名字做稳定次序。
export function orderSymbols(symbols) {
  return [...(symbols || [])].sort((a, b) => (a.start - b.start) || (a.name < b.name ? -1 : 1));
}

// 内部视图的楼层堆叠：一个符号一层，层高 ∝ log10(行数+1)，归一化后总高
// 与城市视图里那栋楼的高度完全一致（同一 heightForLoc 口径）。
export function layoutFloors(file, maxLoc) {
  const totalHeight = heightForLoc(file?.loc, maxLoc);
  const symbols = orderSymbols(file?.symbols);
  const weights = symbols.map(symbol => Math.log10(Math.max(1, symbol.loc || 0) + 1));
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const floors = [];
  let y = 0;
  symbols.forEach((symbol, i) => {
    const height = totalHeight * (sum > 0 ? weights[i] / sum : 1 / symbols.length);
    floors.push({
      id: symbol.id, name: symbol.name, kind: symbol.kind,
      start: symbol.start, end: symbol.end, loc: symbol.loc,
      color: symbolColor(symbol.kind), height, y0: y, y1: y + height
    });
    y += height;
  });
  return { floors, totalHeight, top: y };
}

// 符号内调用邻居：calls 只带同文件符号名，这里映射回符号 id。
// 同名符号（不同类里的同名方法）按起始行取第一个，属于抽取口径下的近似。
export function symbolNeighbors(file, symbolId) {
  const symbols = file?.symbols || [];
  const byName = new Map(), byId = new Map();
  for (const symbol of orderSymbols(symbols)) {
    byId.set(symbol.id, symbol);
    if (!byName.has(symbol.name)) byName.set(symbol.name, symbol);
  }
  const outMap = new Map(), inMap = new Map();
  for (const symbol of symbols) {
    for (const name of symbol.calls || []) {
      const target = byName.get(name);
      if (!target || target.id === symbol.id) continue;
      if (!outMap.has(symbol.id)) outMap.set(symbol.id, new Set());
      outMap.get(symbol.id).add(target.id);
      if (!inMap.has(target.id)) inMap.set(target.id, new Set());
      inMap.get(target.id).add(symbol.id);
    }
  }
  const describe = id => ({ id, name: byId.get(id)?.name || id, kind: byId.get(id)?.kind });
  const collect = map => [...(map.get(symbolId) || [])].map(describe).sort((a, b) => (a.name < b.name ? -1 : 1));
  return { out: collect(outMap), in: collect(inMap) };
}

// 搜索：按路径子串匹配，命中优先给出行数更大的文件。
export function searchFiles(graph, keyword, limit = 12) {
  const needle = String(keyword || '').trim().toLowerCase();
  if (!needle) return [];
  return graph.files
    .filter(file => file.id.toLowerCase().includes(needle))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, limit);
}
