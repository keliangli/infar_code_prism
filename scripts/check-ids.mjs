// 静态自检：确保 JS 里引用的 #id 都在模板中声明过，避免运行时空引用。
import { readFileSync } from 'node:fs';

const files = ['index.html', 'src/main.js'];
const declared = new Set();
for (const file of files) {
  for (const match of readFileSync(file, 'utf8').matchAll(/id="([A-Za-z0-9_-]+)"/g)) declared.add(match[1]);
}
const source = readFileSync('src/main.js', 'utf8');
const referenced = new Set();
for (const match of source.matchAll(/querySelector\(['"`]#([A-Za-z0-9_-]+)/g)) referenced.add(match[1]);

const missing = [...referenced].filter(id => !declared.has(id));
console.log(`引用 ${referenced.size} 个 id，声明 ${declared.size} 个`);
console.log(missing.length ? `MISSING: ${missing.join(', ')}` : 'OK: 所有 #id 引用均已声明');
process.exit(missing.length ? 1 : 0);
