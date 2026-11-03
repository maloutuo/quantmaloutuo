# 绩效分析平台 · 嵌入与重建说明

业绩分析平台（净值 / 收益 / 风险指标 + 多产品共轨对比）作为「绩效分析」标签页，
以 **iframe srcdoc 整页内嵌** 进私募合规工作台，与工作台其余模块双文档隔离、互不污染样式与脚本。

## 目录

- `output/绩效分析平台.html` —— 单文件内联平台（无 ./assets 外链，离线可用），即被内嵌的产物。
- `src/` —— 平台源码（Vite + React 19 + TypeScript + Tailwind），可独立重建。

## 刷新嵌入的平台（日常改动后）

1. 重建单文件产物：
   ```bash
   cd performance/src
   npm install        # 首次需要
   npm run package    # 生成 release/绩效分析平台.html
   ```
2. 覆盖被内嵌的产物：
   ```bash
   cp performance/src/release/绩效分析平台.html performance/output/绩效分析平台.html
   ```
3. 重生成工作台网页（把新平台塞进「绩效分析」标签页的 iframe）：
   ```bash
   cd scripts
   python report.py            # 标准：同时刷新案例库 / 问答库 / 制度生成器
   # 或仅重生成网页（不重建简报）：
   python -c "import report,sys;sys.path.insert(0,'.');r=report.load_ledger();report.build_html(r.get('records',[]))"
   ```
   产物：`output/penalties.html` 与 `output/私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html`。

## 原理

- `report.py` 中 `_load_performance()` 读取 `output/绩效分析平台.html`，对 `&`/`"` 转义后填入模板 `__PERFSRC__` 占位符。
- 标签页按钮 `<button class="tab" data-pane="pPerf">绩效分析</button>` 与面板 `<div class="pane" id="pPerf"><iframe id="perfFrame" srcdoc="__PERFSRC__" …></iframe></div>` 由工作台通用 tab 切换逻辑接管，无需额外 JS。
- 源文件缺失时 `_load_performance()` 返回空串，工作台仍正常产出（仅该标签页留空 iframe）。

## 测试（平台源码内）

```bash
cd performance/src
npm run test    # 218 项：解析 / 指标 / 复权 / 命名 / 压缩包
npm run smoke   # SSR 渲染冒烟
```
