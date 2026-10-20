// 把抽取产物同步到 public/，让 dev 与 build 都能以 /graph.json 访问同一份数据。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = resolve('data/sglang-graph.json');
const target = resolve('public/graph.json');

if (!existsSync(source)) {
  console.error(`找不到 ${source}，请先运行 python tools/extract_graph.py`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`已同步 ${source} -> ${target}`);
