# Code Atlas · SGLang 源码 3D 代码地图

**在线查看**：<https://keliangli.github.io/infar_code_prism/>

把代码库的静态依赖图渲染成一座可交互的“代码城市”：**街区 = 一级子包，建筑 = 文件，建筑高度 ∝ 文件行数**，点击建筑即可查看它依赖谁、又被谁依赖。当前数据快照来自 SGLang 的运行时核心 `python/sglang/srt`。

## 这是什么

- **回答空间问题**：“这块代码在哪、有多大、和谁相邻”，而不是“运行时到底怎么被调用”。
- **三个层级**：概览（44 个街区）→ 街区（子包内的文件构成、跨街区依赖）→ 建筑（单个文件的指标与依赖清单）。
- **两种着色**：按街区区分，或切到“热度着色”看被同根文件 import 的多少。

## 数据快照

| 指标 | 数值 |
| --- | --- |
| 文件（建筑） | 1,904 |
| 总行数 / 代码行 | 820,221 / 675,310 |
| 函数与方法 / 类 | 27,388 / 4,431 |
| 一级子包（街区） | 44 |
| 文件间 import 边 | 11,186 |
| 子包间聚合边 | 407 |
| 未解析 import（第三方、动态导入等） | 10,827 |

## 本地运行

```sh
npm install
npm run dev
```

依赖图数据已随仓库提供（`public/graph.json`），无需本地存在 SGLang 源码即可直接查看。

想用自己的一份源码重新生成数据：

```sh
npm run graph                                  # 默认抽取 python/sglang/srt（需要本地存在该检出）
python tools/extract_graph.py --root <路径>    # 抽取任意 Python 包
node scripts/sync-graph.mjs                    # 把 data/ 下的产物同步到 public/
```

抽取器只用 Python 标准库的 `ast`，不执行被解析的代码，输出为确定性 JSON（同一输入两次运行的哈希一致）。

## 交互

| 操作 | 效果 |
| --- | --- |
| 左键拖动 / 右键拖动 / 滚轮 | 旋转 / 平移 / 缩放 |
| 点击街区或建筑 | 选中并把镜头拉到它，右侧显示检查器 |
| 左侧街区列表 / 被依赖最多 | 直接跳转 |
| 搜索框 | 按路径子串搜索并给出候选列表（回车跳到第一条） |
| 透视 / 俯视 / 侧视 | 相机预设（键盘 `1` `2` `3`） |
| 标签 | 显示或隐藏街区标签；聚焦街区时显示最大的若干文件标签 |
| 热度着色 | 按被依赖程度着色（越暖表示被 import 越多） |
| 数据流讲解 | 按模块顺序讲解一次请求的生命周期（`←` `→` 单步） |
| 回到概览 / `Esc` | 退出聚焦 |

深链接：`#/d/mem_cache`（街区）、`#/f/managers%2Fscheduler.py`（文件）。

## 数据口径与边界

- 图上的边表示**静态 import 关系**，不等于运行时调用关系；注册表、插件与 hook 造成的动态装配无法从静态 AST 得到，因此图中的“缺失”是设计边界，不是代码缺陷。
- `loc` 为文件总行数（含空行），`codeLines` 为非空且非纯注释行数的近似值。
- 只统计能解析到同一根目录内文件的内部依赖；跨仓库、第三方库与动态导入计入「未解析 import」而不作图。
- 该视图的定位是“代码地图”，不是调用真相；需要时序请用 trace/日志类工具。

## 目录结构

```text
.
├── tools/extract_graph.py      静态依赖抽取（标准库 ast，确定性输出）
├── scripts/sync-graph.mjs      把抽取产物同步到 public/
├── scripts/check-ids.mjs       自检：JS 引用的 #id 是否都已声明
├── data/sglang-graph.json      抽取产物（存入 public/ 供前端读取）
├── public/graph.json           前端实际加载的数据
├── src/derive.js               纯逻辑：布局、配色、邻居与搜索（可单测）
├── src/scene.js                Three.js 场景：InstancedMesh 建筑、拾取、依赖连线、标签
├── src/main.js                 界面：面板、检查器、讲解步骤、路由与快捷键
├── src/style.css
└── test/derive.test.js         布局与依赖逻辑的单测
```

## 部署

站点通过 **GitHub Pages** 发布，线上地址：<https://keliangli.github.io/infar_code_prism/>

每次 push 到 `main` 会触发 `.github/workflows/deploy-pages.yml`：`npm ci` → `npm test` → 按 `configure-pages` 给出的子路径构建并发布 `dist`。前端用 `import.meta.env.BASE_URL` 读取 `graph.json`，因此子路径部署与本地开发使用同一份数据路径。首次使用需在仓库 Settings → Pages 把 Source 设为 “GitHub Actions”。

## 性能与实现要点

- 1,904 个文件按街区各建成一个 `InstancedMesh`，整图只有 44 次 draw call；拾取通过 `instanceId` 反查文件。
- 标签采用两阶段渲染：先统一写可见性，再统一读一次尺寸并缓存，避免逐标签读取导致的强制重排。
- 布局为强约束的行式装箱（街区不重叠、建筑不出界），而非力导向，保证同一仓库多次生成的图看起来一致，便于形成空间记忆。
