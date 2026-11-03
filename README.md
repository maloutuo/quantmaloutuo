# 私募合规工作台 · Private Fund Compliance Workbench

[![version](https://img.shields.io/badge/version-1.4.6-blue)](CHANGELOG.md)
[![license](https://img.shields.io/badge/license-MIT%20%2B%20CC%20BY%204.0-green)](LICENSE)
[![python](https://img.shields.io/badge/python-3.10%2B-3776AB)](requirements.txt)

> 给**私募证券投资基金管理人**用的合规工作台：把监管处罚数据、合规问答知识、内控制度生成、产品绩效分析装进**一个双击即开的 HTML 文件**，离线可用。
>
> ⚠️ 本项目是辅助工具，**不构成法律意见或投资建议**。详见 [DISCLAIMER.md](DISCLAIMER.md)。

---

## 它解决什么问题

| 痛点 | 这个工具怎么做 |
|---|---|
| 处罚案例散在 17 个证监局 + 中基协网站，看完不知道"到底违反了哪条" | 按日采集 36 个官方源，每条案例叠加**法规条款锚点 / 案例法锚点 / 自查启示**三层解读 |
| 业务问题搜不到答案，或者搜到的是已废止的旧口径 | 401 条场景的合规问答库，每条给结论 + 精确到条款号的法规依据 + 实务踩坑点 |
| 内控制度不知从哪写起，写了又怕漏 | 输入组织架构，按 36 个模块生成制度草案，每条附【依据】+【原文】，并指出需补建的部门与人头 |
| 产品净值一堆 Excel，算指标容易错 | 内嵌绩效分析单页，导入 xlsx/csv 即出夏普、回撤、超额、月度热力图 |

---

## 截图

> 图片放在 `docs/images/`，建议 4 张：案例库（含三层锚点展开）、问答库检索、制度生成器、绩效分析。命名见 [docs/images/README.md](docs/images/README.md)。

```
docs/images/01-cases.png     监管案例库：六筛选 + 三层锚点
docs/images/02-qa.png        合规问答库：结论/依据/踩坑点
docs/images/03-policy.png    制度生成器：组织架构 → 制度
docs/images/04-perf.png      绩效分析：净值 → 指标
```

---

## 四大模块

| Tab | 内容 | 关键能力 |
|---|---|---|
| **① 监管案例库** | 证监会及派出机构、中基协公开的私募处罚与纪律处分 | 六维筛选 +「只看重复受罚主体」；三层锚点：法规条款 / 案例法（累犯·跨机关·处分升级轨迹）/ 自查启示 |
| **② 合规问答库** | 401 条场景 / 8 卷：募投管退、内部控制、托管外包、程序化交易、监管检查、税务、合同管理 | 关键词 + 主题 + 分类检索，命中高亮；结论 + 法规依据 + 踩坑点三段式 |
| **③ 制度生成器** | 36 个内控模块（25 必建 + 11 触发）、165 条条款骨架 | 组织架构校验 → 模块选型 → 逐条生成，每条附【依据】+【原文】；输出需补建部门与人头建议 |
| **④ 绩效分析** | 独立 React 单页，iframe 内嵌 | xlsx/csv/zip 导入、五种复权口径、夏普/索提诺/卡玛/最大回撤/超额/跟踪误差、月度热力图 |

---

## 安装

本仓库根目录即 skill 根目录，直接放进宿主 Agent 的 skills 目录即可。

```bash
# 1. 克隆
git clone https://github.com/<your-account>/quantmaloutuo.git \
  ~/.workbuddy/skills/quantmaloutuo

# 2. 装依赖（仅 4 个第三方库）
cd ~/.workbuddy/skills/quantmaloutuo
pip install -r requirements.txt

# 3. 首次采集 + 生成产物（约 6 分钟，36 个源、3 秒限速）
python scripts/bootstrap.py
```

其他宿主（Claude Code / Cursor / Codex 等）把目录放进各自的 skills 目录即可，脚本本身不依赖宿主 API。

已发布到 SkillHub 的版本也可一键安装：

```bash
skillhub install quantmaloutuo --namespace user_e7ed2541 --dir ~/.workbuddy/skills
```

> 两种装法只选一种。仓库里不含 `_meta.json`（SkillHub 的发布元数据，只有 `ownerId`/`publishedAt`/`slug`/`version` 四个字段），所以 git clone 的副本不会被 `skillhub` 认作已安装版本，后续想收更新得走 `skillhub install`。

### 克隆后先跑什么

仓库**不含运行时数据**（`data/` 与 `output/` 由脚本首次运行生成），但两个内嵌构建产物已入库，所以：

| 你想要的 | 命令 | 结果 |
|---|---|---|
| 先看界面长什么样 | `python scripts/bootstrap.py --quick` | 秒级出页面（约 3 MB），Tab 2/3/4 完整，**Tab 1 案例库为空** |
| 要真实数据 | `python scripts/bootstrap.py` | 联网约 6 分钟，36 个源，采集完成后四个 Tab 全量可用 |

即"零数据也能打开"，但案例库要靠首次采集填充。已实测：全新 `git clone` 后直接跑 `--quick`，返回码全 0，页面可正常打开。

> `performance/output/绩效分析平台.html` 与 `generator/output/私募证券基金管理人内控制度生成器.html`
> 是 `scripts/report.py` 内联注入的运行时资源，故意入库（按二进制处理以保字节一致）。要重建绩效平台前端，见 `performance/BUILD.md`；制度生成器用 `python generator/scripts/build_platform.py`。

---

## 30 秒上手

```bash
python scripts/bootstrap.py --quick   # 不联网，只重建产物（秒级）
open output/私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html
```

双击 HTML 即开，四个 Tab 全部离线可用。

常用参数：

| 参数 | 作用 |
|---|---|
| `--quick` | 跳过联网采集，只用现有台账重建产物 |
| `--days N` | 简报窗口天数（默认 30） |
| `--pages N` | 各源列表翻页深度（默认 3，可覆盖约一周的漏跑日） |

每次运行结束会写 `data/last_run.json`（mode / 各步返回码 / 新增条数 / 最新快照），**判断"这轮有没有真的联网采集"看这个文件，不要看 `ledger.json` 的 `last_run`**——后者会被离线重建刷新。

---

## 目录结构

```
quantmaloutuo/
├── SKILL.md                  # 工作流与硬规则（Agent 入口）
├── references/               # 合规问答知识库 8 卷（401 条场景）
│   ├── 01-fund-lifecycle.md      # 基金募投管退 233 条
│   ├── 02-tax.md                 # 税务 15 条
│   ├── 03-internal-control.md    # 内部控制 57 条
│   ├── 04-programmatic-trading.md# 程序化交易 27 条
│   ├── 05-custody.md             # 托管与外包 32 条
│   ├── 06-contract.md            # 合同管理 15 条
│   ├── 07-regulatory-inspection.md # 监管检查与争议解决 22 条
│   └── 08-appendix.md            # 法规索引与免责
├── scripts/                  # 采集与分析引擎
│   ├── bootstrap.py          # ★ 一键：采集 → 索引 → 写回 → 产物 → 发布
│   ├── fetch.py              # 36 个官方源的采集器
│   ├── kb_index.py           # 问答库 → 结构化索引
│   ├── anchor.py             # 法规条款锚点 + 案例法锚点
│   ├── report.py             # 简报(MD/DOCX) + 四 Tab 网页
│   ├── publish.py            # 每日发布
│   ├── ocr_apply.py          # 扫描件转录稿写回
│   └── ocr_backend.py        # 扫描件三级抽取
├── generator/                # 制度生成器（独立资产 + 自己的 SKILL.md）
├── performance/              # 绩效分析平台（src 源码 + output 构建产物）
└── docs/                     # 数据来源、安装细节、截图
```

首次运行后会自动生成 `data/`（台账、索引、转录稿、缓存）与 `output/`（网页、简报），二者已在 `.gitignore` 中排除。

---

## 数据来源与更新机制

- **36 个源**：中基协纪律处分（机构 / 人员各 1 个）+ 证监会总会行政处罚 + 17 个地方证监局的「监管措施」「行政处罚」栏目（北京局仅监管措施）
- **节奏**：每次运行增量采集，各源列表前 3 页，约 108 次列表请求，请求间隔 3 秒（不并发压站）
- **耗时**：实测一轮 375–398 秒，其中采集约 350 秒
- **容错**：任一环节失败不阻断后续，采集挂了仍用现有台账重建产物
- **扫描件**：中基协处分多为扫描 PDF，无文本层，走「渲染页图 → 视觉转录 → 写回台账」三级流程

详细清单与合规约定见 [docs/data-sources.md](docs/data-sources.md)。

---

## 已知限制

1. **仓库不携带数据**：clone 下来是空台账，首次运行才采集。实测规模约 600 条、覆盖 2018 年至今。
2. **只覆盖私募证券类**：股权创投类管理人的规则差异较大，问答库未覆盖。
3. **三层锚点是 AI 解读**：页面已标注「非监管原文」，只有来源 / 机构 / 处罚 / 原文四段可引用。
4. **制度生成器输出的是草案**：须经本机构合规风控负责人审核、最高权力机构审议通过（《内控指引》第三条）。
5. **定时更新依赖宿主**：宿主 Agent 的自动化只在应用运行时触发，不是系统级 cron。
6. **平台**：脚本在 Windows + Python 3.13 实测；macOS / Linux 理论可行但未充分测试。

---

## 开发

```bash
python -m compileall -q scripts generator/scripts     # 语法检查
python scripts/kb_index.py                            # 重建问答索引
python generator/scripts/build_platform.py            # 构建制度生成器单页
python generator/scripts/check_platform.py            # 冒烟校验
```

改 `references/` 后必须重跑 `kb_index.py` + `report.py`（或 `bootstrap.py --quick`），否则网页仍是旧内容。

---

## 许可证

本项目著作权人：**马喽驼**（2026）。

- **代码**（`scripts/`、`generator/`、`performance/src/`）：[MIT](LICENSE)
- **文档与问答库**（`references/`、`SKILL.md`、`docs/`）：[CC BY 4.0](LICENSE-docs)
- **法规原文引用**：《著作权法》第五条规定，法律、法规、国家机关的决议决定命令等官方文件不适用著作权保护

转载问答库请保留出处与免责声明。

---

## 免责声明

本工具仅用于内部合规参考，**不构成法律意见、不构成投资建议、不构成对任何具体业务的合规结论**。使用者应自行核对现行有效法规并咨询专业顾问，因使用本工具产生的后果由使用者自行承担。完整条款见 [DISCLAIMER.md](DISCLAIMER.md)。
