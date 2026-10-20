// 把抽取产物同步到 public/，让 dev 与 build 都能以 /graph.json 访问同一份数据。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function sync(source, target) {
  if (!existsSync(source)) return false;
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log(`已同步 ${source} -> ${target}`);
  return true;
}

// 当前快照：前端主数据源，缺失即失败。
if (!sync(resolve('data/sglang-graph.json'), resolve('public/graph.json'))) {
  console.error(`找不到 ${resolve('data/sglang-graph.json')}，请先运行 python tools/extract_graph.py`);
  process.exit(1);
}

// 上一版本基线：供前端做版本对比，可选产物；缺失只提示、不报错退出。
if (!sync(resolve('data/sglang-graph.previous.json'), resolve('public/graph.previous.json'))) {
  console.log('未找到 data/sglang-graph.previous.json，跳过上一版本基线（可用 npm run graph:previous 生成）');
}
