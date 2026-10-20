// 从旧版本 git tag 重新生成“上一版本”依赖图基线（data/sglang-graph.previous.json）。
//
// 用法：
//   npm run graph:previous                     # 抽取 + 同步到 public/，默认 ref = v0.5.12
//   node scripts/make-baseline.mjs v0.5.16     # 指定旧版本 ref（命令行位置参数优先）
//
// 环境变量（本地 git 检出路径依机器而异，故做成可配置）：
//   SGLANG_REPO          本地 sglang git 检出路径（默认 D:\code\sglang\sglang-main）
//   SGLANG_BASELINE_REF  旧版本 ref / tag（默认 v0.5.12）
//
// 实现：用 `git archive` 取出该 ref 下的 python/sglang/srt 到临时目录（不改动、也不
// checkout 现有检出），复用 tools/extract_graph.py 抽取为 data/sglang-graph.previous.json，
// 最后无论成功与否都会清理临时目录与 tar 包。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRT_REL = 'python/sglang/srt';
const OUT_REL = 'data/sglang-graph.previous.json';

const repo = process.env.SGLANG_REPO || 'D:\\code\\sglang\\sglang-main';
const ref = process.argv[2] || process.env.SGLANG_BASELINE_REF || 'v0.5.12';

function countPythonFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) n += countPythonFiles(p);
    else if (entry.name.endsWith('.py')) n += 1;
  }
  return n;
}

if (!existsSync(repo)) {
  console.error(`找不到 SGLANG_REPO：${repo}（用环境变量 SGLANG_REPO 指定本地 sglang 检出）`);
  process.exit(1);
}

const commit = execFileSync('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`], {
  encoding: 'utf8',
}).trim();
console.log(`基线 ref = ${ref}（commit ${commit}）`);

const expectedPy = execFileSync(
  'git',
  ['-C', repo, 'ls-tree', '-r', ref, '--name-only', '--', SRT_REL],
  { encoding: 'utf8' }
)
  .split('\n')
  .filter((line) => line.endsWith('.py')).length;

const workDir = mkdtempSync(join(tmpdir(), 'sglang-baseline-'));
const tarPath = join(workDir, 'srt-baseline.tar');
const extractDir = join(workDir, 'src');
const srtRoot = join(extractDir, ...SRT_REL.split('/'));

try {
  execFileSync('git', ['-C', repo, 'archive', '--format=tar', '-o', tarPath, ref, SRT_REL], {
    stdio: 'inherit',
  });

  mkdirSync(extractDir, { recursive: true });
  try {
    execFileSync('tar', ['-xf', tarPath, '-C', extractDir], { stdio: 'inherit' });
  } catch {
    // Windows 下 bsdtar 可能无法创建符号链接（如 .clang-format）而以非 0 退出；
    // 只要 .py 文件完整即可用，因此不致命，交给下面的数量校验兜底。
    console.warn('tar 退出码非 0（通常是个别符号链接无法创建），继续校验 .py 完整性');
  }

  const actualPy = countPythonFiles(srtRoot);
  if (actualPy !== expectedPy) {
    throw new Error(`源码不完整：解出 ${actualPy} 个 .py，但 ${ref} 应有 ${expectedPy} 个`);
  }
  console.log(`源码校验通过：${actualPy} 个 .py 文件（与 ${ref} 一致）`);

  execFileSync(
    'python',
    [resolve(PROJECT_ROOT, 'tools/extract_graph.py'), '--root', srtRoot, '--out', resolve(PROJECT_ROOT, OUT_REL)],
    { cwd: PROJECT_ROOT, stdio: 'inherit' }
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
  console.log(`已清理临时目录 ${workDir}`);
}
