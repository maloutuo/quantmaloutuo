---
name: quantmaloutuo
slug: private-fund-compliance-workbench
display_name: 私募基金工作台·监管爬虫锚点解读·制度生成器·绩效分析·运管投知识库
displayName: 私募基金工作台·监管爬虫锚点解读·制度生成器·绩效分析·运管投知识库
version: 1.4.6
tags: [私募基金, 合规, 监管处罚, 案例库, 合规问答, 锚点解读, 中基协, 证监局, 制度生成器, 内控制度, 组织架构诊断, 绩效分析, 投资人分析]
description: >
  私募基金合规工作台:单文件网页交付,双击即开、离线可用,打开即自动增量更新。四大并列栏目:
  1. 监管案例库——证监会及派出机构、中基协官网按日采集私募处罚与纪律处分,输出结构化台账与四段式简报,每条叠加法规条款/案例法/自查启示三层锚点解读,支持"只看重复受罚主体"过滤;
  2. 合规问答库——私募证券基金合规问答,按募投管退、税务、内控、程序化交易、托管外包、合同管理、监管检查七类组织,结论+法规依据+踩坑点三段式;
  3. 制度生成器——输入组织架构输出全套内控制度,每条附法规原文出处并给出需补建部门与人头建议;
  4. 绩效分析平台——独立 React + Tailwind 单页(投资人/产品绩效分析),以 iframe srcdoc 原样内嵌为第四标签页,与工作台样式/脚本完全隔离。
  触发词:监管处罚、纪律处分、合规问答、每日简报、每天更新案例库、制度生成器、绩效分析、投资人分析、产品绩效。
agent_created: true
---

# 私募基金工作台 · 监管爬虫锚点解读 · 制度生成器 · 绩效分析 · 运管投知识库

## 打开即更新(每次加载本 skill 的第一动作)

**用户的明确要求:每次打开该 skill 都要自动更新里面的信息。** 因此每当本 skill 被加载/触发,
agent **必须先执行**:

```bash
python scripts/bootstrap.py
```

`bootstrap.py` 串起完整更新链,自动依次完成并打印状态摘要:

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1 | 增量采集 | 36 个源(中基协 2 + 证监会总会 + 17 个地方局 × 监管措施/行政处罚)各翻 **3 页**(`--pages`,默认 3),约 108 次列表请求,**受 3s 限速约束实测约 360s** |
| 2 | 重建知识库索引 | `references/*.md` → `data/kb_index.json`,401 条场景(约 1s) |
| 3 | 转录稿写回 | `ocr_apply.py`,把已完成的扫描件转录挂进台账(幂等,约 1s) |
| 4 | 重生成产物 | 简报(MD/DOCX)+ 四 Tab 网页(含三层锚点解读 + 绩效分析平台,约 1s) |
| 5 | 发布 | 复制到 `output/daily/私募监管处罚简报_最新.docx` |

**总耗时实测 ≈ 6 分钟**(2026-09-30 三次实测:采集 360s / 364s / 359s,其余各步合计 <5s)。
耗时几乎全在采集的列表请求上。若需提速,可调低 `FETCH_INTERVAL`(默认 3.0,如设 1.5 可减半)
或 `CSRC_PAGES` / `CSRC_PUNISH_PAGES`(默认各 3),但请勿低于 1s 以免被目标站限流。

参数:`--quick` 跳过联网只重建产物(离线可用);`--days N` 指定简报窗口;`--pages N` 指定翻页深度(**默认 3 页**——取 3 页是为了让漏跑一天不至于永久漏采,只取首页时次日的列表可能已经滚过那几条)。

跑完会把本轮状态写入 `data/last_run.json`(mode / 各步 rc / 新增条数 / 最新快照名)。**判断"这一轮有没有真的联网采集"要看这个文件的 `mode` 与 `latest_snapshot`,不要看 `ledger.json` 的 `last_run`**——后者被 `ocr_apply.py` 无条件刷新,`--quick` 也会改。

**容错设计**:任一环节失败都不阻断后续——采集挂了仍用现有台账重建网页,保证用户始终能拿到可用产物。
跑完后向用户汇报:新增多少案例、台账总量、正文完整率、问答库条数、网页路径。

然后**用 `present_files` 交付网页**(`output/私募合规工作台·案例库+锚点解读+制度生成器.html`,双击即开、无需联网)。

## 能力入口与唤醒词

本技能工作台含四大能力:监管案例库、合规问答库、制度生成器、绩效分析平台。
其中制度生成器与绩效分析平台各有独立资产目录,与包根案例库/问答库的数据互不干扰;
按下列唤醒词路由到对应动作即可。

### 一、唤醒词

| 唤醒词 | 触发的能力 |
|---|---|
| **制度生成器** | 内控制度生成 + 组织架构诊断 |
| 生成制度 / 写内控制度 / 按我们组织架构出一套制度 / 每条要能引用法规原文 | 同上 |
| **绩效分析** | 打开工作台「绩效分析」标签页(内嵌的 React 单页,离线可用) |
| 绩效分析平台 / 投资人分析 / 产品绩效 | 同上 |

识别到上述任一说法即按本 skill 原有习惯**先动手**:构建产物 → 起本地服务 →
**把网络连接交付过去**。

### 二、资产位置

制度生成器**整包**放在 `generator/` 下,与包根资产互不干扰、文件名不重名:

```
generator/
├── SKILL.md      ← 制度生成器自己的工作流与硬规则（原样,未改动）
├── references/   01-法规原文库.md          02-制度模块与法规映射表.md
│                 05-运作指引全文.md         06-适当性办法全文.md
│                 07-私募条例全文.md         09-制度条款库.json
├── scripts/      intake_check.py(校验+选型)   build_platform.py(构建)
│                 check_platform.py(冒烟)      serve.py(本地服务)
├── templates/    platform.html   组织架构输入.json   制度模板-精简版.md
└── output/       私募证券基金管理人内控制度生成器.html
```

生成制度时**按 `generator/SKILL.md` 的流程走**：先核对原文再落笔、脚注式给
【依据】+【原文】、模块选型以脚本输出为准——三条硬规则与已知法律冲突都记在那里。

### 三、动作顺序(核心)

**① 构建**（改了 `generator/references/` 后必须重跑）：

```bash
python generator/scripts/build_platform.py    # 产出单文件网页
python generator/scripts/check_platform.py    # 冒烟校验，不通过不得交付
```

**② 起本地服务**：

```bash
python generator/scripts/serve.py             # 默认 8733，只监听 127.0.0.1
```

**③ 把网络连接发过去** —— 用 `present_files` 交付：

```
http://127.0.0.1:8733/
```

这是唤醒「制度生成器」时用户要拿到的那个链接，预览面板直接打开即可用。

> **端口说明**：默认 8733。若已被别的程序占用，`serve.py` 会**自动顺延到下一个可用端口**
> 并在启动横幅里打印实际地址。**交付时以启动横幅打印的地址为准**，不要想当然写 8733。

服务起不来（`--no-open` / 无浏览器）时，**退回交付单文件交付网页**
`output/私募合规工作台·案例库+锚点解读+制度生成器.html`（第三个 Tab 即制度生成器），
或独立单页 `generator/output/私募证券基金管理人内控制度生成器.html`，双击即开、无需联网。

### 四、交付时必须捎带的一句

生成结果是**制度草案**，须经该机构合规风控负责人审核、最高权力机构审议通过后生效
（《内控指引》第三条）。

### 五、包内目录

```
quantmaloutuo/
├── SKILL.md          ← 本文件
├── generator/        ← 制度生成器(独立资产:SKILL.md / references / scripts / templates / output)
└── performance/      ← 绩效分析平台(独立单页:output/绩效分析平台.html)
```

两套并入资产各自独立:制度生成器只读 `generator/`,绩效分析平台只读 `performance/`,
**均不读包根案例库/问答库的任何数据**;工作台网页由 `scripts/report.py` 把三者拼进同一文件。

## 工作台四大栏目

交付网页 `output/私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html` 为单文件,
双击即开、离线可用,顶部四个并列 Tab:**监管案例库 → 合规问答库 → 制度生成器 → 绩效分析**。
四个栏目互不干扰,各自数据源独立。

### 栏目 A:监管案例库(爬虫库)

从公开监管渠道按日采集,产出:**结构化台账(JSON)+ 四段式简报(MD/DOCX)+ 可检索网页**。
台账当前 **539 条**(覆盖 2018-12-29 ~ 2026-09-30),正文完整 **539 条**(完整率 100%),
其中 **154 条**为扫描件视觉转录(agent_vision),待转录 **0 条**、失败 **0 条**。

检索维度:关键词(当事人/标题/正文/**法规条款号**)、来源、机构/个人、违规类型、处分措施、
**援引法规**,外加「只看重复受罚主体」一键过滤。

### 栏目 B:合规问答库

`references/` 下 8 个知识库文件,合并为 **401 条可检索场景**:

| 主题 | 条数 | 覆盖范围 |
|---|---|---|
| 基金募投管退 | 233 | 募集与适当性、备案、产品设计、投资运作、存续运营、退出清算、反洗钱、信息披露 |
| 内部控制 | 57 | 内控制度、岗位分离、投资决策、授权控制、员工申报、关联交易、档案、应急、数据安全 |
| 托管与外包 | 32 | 估值复核、划款监督、托管人协作、外包管理、份额登记、对账 |
| 程序化交易 | 27 | 程序化认定、报告义务、高频交易、异常监控、DMA/QFII、策略留痕 |
| 监管检查与争议解决 | 22 | 现场检查、行政处罚、自律处分、诉讼仲裁、舆情应对、合规自查清单专项工具 |
| 税务 | 15 | 增值税(估值表/台账/申报)、个税、企业所得税、FATCA/CRS |
| 合同管理 | 15 | 电子签约、合同签署/回收、用章授权、存证效力 |

检索维度:关键词(问题/正文/法规名)、主题、分类,支持命中高亮。

**索引构建**:`kb_index.py` 把 markdown 切分为结构化条目。
> **踩坑**:原汇编存在**两套编号体系**(150场景汇编的「场景1-150」+ 客户100场景/第四辑100场景另行编号),
> 同一卷内编号会重复(01 卷重复 119 次),**不可用编号作唯一键**。
> `kb_index.py` 用「行首场景标记出现顺序」作序,以 `(volume, ordinal)` 为唯一标识。

**离线检索**(不打开网页时):直接 grep references 目录。
```bash
grep -n "冷静期" references/01-fund-lifecycle.md
grep -n "估值复核" references/05-custody.md
```



## 三层锚点解读(本 skill 的核心增量)

打开网页点开任一案例,原文之外叠加三层解读。**三层均为 AI 解读,输出时必须标注"非监管原文"**,
原文段(来源/机构/处罚/原文)才是可引用的事实。

### ① 法规条款锚点 `law_anchors`

从处罚原文抽取**被援引的法规与具体条款号**,给条文要点与原文引用句。
引擎在 `scripts/anchor.py` 的 `extract_law_anchors()`,关键算法是**按法规名出现位置划分归属区间**:

```
原文写法(顿号串联):
  ……违反了《关于加强私募投资基金监管的若干规定》第十二条、
  《私募投资基金登记备案办法》第四条、《私募基金监管办法》第二十四条的相关规定。

算法:
  1. 扫描全文,记录每个法规名出现的所有字符位置,按位置排序
  2. 第 i 个法规名的归属区间 = [第 i 个位置, 第 i+1 个位置),再截断到第一个句号/分号
  3. 区间内出现的"第X条"即归属该法规
```

> **踩坑**:早期版本对每个法规名单独在全文搜条款号,导致"《基金法》……《私募基金监管办法》第二十四条"
> 这类句子里,《基金法》也误配到第二十四条。必须限位到法规名之后的紧邻区间。

条文要点表 `LAW_CATALOG` 覆盖 10 部常用规范:证券投资基金法、私募投资基金监督管理暂行办法、
私募投资基金管理人登记和基金备案办法、私募投资基金募集行为管理办法、关于加强私募投资基金监管的若干规定、
证券期货投资者适当性管理办法、证券期货经营机构私募资产管理业务运作管理暂行规定、证券法、
中基协自律管理和纪律处分措施实施办法、中基协会员管理办法。新增法规只需往表里加一条。

### ② 案例法锚点 `doctrine`

按**当事人**聚合其全部历史处罚,识别合规风险最强信号——"同类问题被反复处罚":

- **累犯计数**:同一主体被处分 ≥2 次(当前 25 个主体命中)
- **跨机关叠加**:同一主体被多家监管机关处分(如上海亚格=上海证监局+中基协;张守军=中基协+北京证监局),
  跨辖区协同监管意味着风险等级更高
- **处分升级轨迹**:按措施严重度排序,自动识别 `警告→责令改正→公开谴责→暂停备案→撤销管理人登记` 的演进
- **反复踩线类型**:该主体多次出现的违规标签

严重度序在 `anchor.py: MEASURE_SEVERITY`,聚合函数 `build_all_doctrine()`(供网页按当事人名 O(1) 命中)。

### ③ 自查启示 `insights`

沿用 `report.py: INSIGHT_RULES`——违规类型标签 → 共性自查建议 + 本案事实锚点(从原文摘出的具体事实句)。

## 简报体例(用户指定,勿改)

每个案例固定四段 + 原文:

1. **【来源】** 监管机构 + 文书标题 + 官方链接;扫描件注明"无法可靠转 Word,按 PDF 原件附出",原件归档于 `output/pdfs/{date}_{subject}.pdf`;
2. **【机构】** 当事人 + 机构/个人 + 辖区(个人案附当事人身份,取正文前 200 字当事人段,勿把申辩中他人职务算入);
3. **【处罚措施】** 措施列表 + 罚款金额;
4. **【案例原文】** 原文照搬,一字不改(agent_vision 转录的须与扫描件逐页核对);
5. **【自查启示】** AI 基于处罚事实生成的解读,**必须标注"非监管原文"**——来源/机构/处罚/原文四段是原文,启示不是。

扫描件转录完成后运行 `python ocr_apply` 写回台账即可(无需重抓,见「扫描件转录管道」)。

## 目录结构

```
regulatory-penalty-tracker/
├── SKILL.md              # 本文件
├── references/           # 合规问答知识库(7 卷主题 + 附录,401 条场景)
│   ├── 01-fund-lifecycle.md      # 基金募投管退 233 条
│   ├── 02-tax.md                 # 税务 15 条
│   ├── 03-internal-control.md    # 内部控制 57 条
│   ├── 04-programmatic-trading.md# 程序化交易 27 条
│   ├── 05-custody.md             # 托管与外包 32 条
│   ├── 06-contract.md            # 合同管理 15 条
│   ├── 07-regulatory-inspection.md # 监管检查与争议解决 22 条
│   └── 08-appendix.md            # 附录(法规引用索引、免责声明)
├── generator/           # 制度生成器(独立资产:SKILL.md / references / scripts / templates / output)
├── performance/         # 绩效分析平台(独立单页:output/绩效分析平台.html)
├── scripts/
│   ├── bootstrap.py      # ★ 打开即更新:采集→索引→写回→生成产物→发布
│   ├── common.py         # HTTP/编码修复/清洗/去重/字段抽取(共用库)
│   ├── fetch.py          # 采集器(多源列表+详情+增量+扫描件渲染入队)
│   ├── kb_index.py       # 知识库索引构建(markdown → 结构化场景 JSON)
│   ├── anchor.py         # 锚点解读引擎(法规条款锚点 + 案例法锚点)
│   ├── report.py         # 简报(MD/DOCX)+ 四 Tab 网页(HTML,含三层锚点 + 绩效分析平台 iframe)
│   ├── publish.py        # 每日发布(复制到 output/daily/ 固定位置)
│   ├── ocr_apply.py      # 把 ocr_queue 的 transcript.txt 写回台账(幂等)
│   └── ocr_backend.py    # 扫描件三级抽取(文本层/OCR/视觉转录队列)
├── data/
│   ├── ledger.json       # 增量台账(核心资产,勿删)
│   ├── last_run.json     # 每轮运行状态(mode/各步 rc/新增数/最新快照,供巡检)
│   ├── kb_index.json     # 知识库检索索引(由 kb_index.py 生成)
│   ├── transcripts/      # 转录稿扁平备份(<uid>.txt)
│   ├── cache/            # HTTP与OCR缓存(24h,可安全清理,自动重建)
│   ├── raw/              # 每次运行的原始采集结果快照
│   └── ocr_queue/        # 扫描件队列目录(<uid>/,仅存 transcript.txt 与 .queued 标记)
└── output/
    ├── briefing_YYYYMMDD.md/.docx
    ├── daily/            # 每日发布位置:私募监管处罚简报_最新.docx + 历史副本
    ├── pdfs/             # 扫描件原件归档({date}_{subject}.pdf)
    ├── penalties.html    # 构建产物(由 report.py 生成)
    └── 私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html  # ★ 交付网页:四栏,双击即开
                                                       #   由 bootstrap.py 自动从 penalties.html 同步
```

## 网页使用(交付给用户的主要入口)

`output/私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html` 单文件、双击用浏览器打开即可,不需要服务器、不需要联网。

**Tab 1 · 监管案例库**:六个筛选器 + 「只看重复受罚主体」。
详情区自上而下:① 元信息与原文链接 → ② 法规条款锚点(紫) → ③ 案例原文 → ④ 案例法锚点(红) → ⑤ 自查启示(黄)。

**Tab 2 · 合规问答库**:三个筛选器 + 关键词高亮。
详情区:问题标题 → 主题/分类/原编号 → 完整问答正文(三段式)。

**Tab 3 · 制度生成器**:输入组织架构(公司名 + 部门/岗位/人数),一键生成全套内控制度,每条附法规原文出处,并给出需补建的部门与人头建议。

**Tab 4 · 绩效分析**:内嵌的 React + Tailwind 单页(投资人/产品绩效分析),以 iframe 原样加载,与工作台样式/脚本完全隔离,离线可用。

## 扫描件转录管道(重要)

中基协处分 PDF **全部是扫描件**,无文本层。三级抽取流程:

1. `fetch.py` 检测无文本层 → 渲染最多 10 页 PNG(170 dpi)入 `data/ocr_queue/<PDF文件名>/page_N.png`,
   同时写 `.queued` 标记,台账标 `body_status=pending_ocr`
2. 由 agent 逐页视觉转录 → 写 `data/ocr_queue/<uid>/transcript.txt`(UTF-8 纯文本)
3. `python ocr_apply.py` 把 transcript 写回台账(`body=文本`, `extract_method=agent_vision`,
   `body_status=ok`),**无需重新抓取**

批量转录用并行子代理:每批 3-7 个转录员、每人 4-11 项,单个 prompt 自包含(目录清单、逐页 Read、
转录规范、Write transcript.txt、逐项报告字数)。转录规范:原文照搬、保留文书结构(标题/文号/当事人段/
一二三节)、忽略红头公章页码、跨页拼接、模糊字"□"占位、结尾"中国证券投资基金业协会+日期+抄送"完整。

**转录成果**:539 条台账中 **154 条**为视觉转录,扫描件正文已全部补齐,**待转录 0 条**。

## 数据源(最小版)

### 一、中基协(静态 HTML + 双重编码修复)

| key | 来源 | 列表页 | 抽取方式 |
|---|---|---|---|
| `amac_org` | 中基协·纪律处分·受处分机构 | `/zlgl/jlcf/scfjg/` | 扫描件 PDF → 视觉转录 |
| `amac_person` | 中基协·纪律处分·受处分人员 | `/zlgl/jlcf/scfry/` | 扫描件 PDF → 视觉转录 |

**静态分页**:列表页内 `createPageHTML(34, 0, "index","html")` 声明总页数(机构栏 34 页),
第 2..N 页是同目录 `index_1.html` .. `index_{N-1}.html`(TRS CMS 惯例,首页即第 1 页)。
日常只采第 1 页;回填时设 `AMAC_PAGES=n` 采集前 n 页。
处分 PDF 全是扫描件,回填新增项会进入 `ocr_queue/` 等待视觉转录,
转录完成前在台账中标记 `pending_ocr`。

**页面双列表结构(2026-09-22 关键发现)**:每个页面(含 index_N 历史页)有两处列表,
必须双解析器都跑再按 URL 去重,只按 tab 注释解析会漏掉历史条目:

| 区域 | 结构 | 条数 | 解析器 |
|---|---|---|---|
| 页首 tab widget 区 | `<a href="./202609/P....pdf">标题<i>09-11</i></a>`(日期在 a 内、无年份) | 约 4 条 | `parse_amac_list` |
| 页尾真实分页列表区 | `<li><span></span><a href="./202609/P....pdf">标题</a><i> 2026-09-11 </i></li>`(完整日期在 a 外) | 每页约 18 条 | `parse_amac_full_list` |

`AMAC_LIST_PAT` 的 href 限定 `(?:\./)?\d{6}/P\d+` 开头,排除页面上其它栏目
(如 `../../../hydj/djdt/` 党建动态新闻附件)的 PDF 误配;widget 区日期无年份,
不会与全列表正则重叠。翻页与解析顺序:base 页 + index_1..N 页 → 每页双解析 → URL 去重。
修复前症状:翻页取到的全是重复的 4 条 widget 数据(UID 去重后新增 0),历史条目漏采。

### 二、证监会系统(统一 JSON 接口,无需 Playwright)

**核心发现**:证监会所有栏目共用统一搜索接口,直接返回 JSON:

```
https://www.csrc.gov.cn/searchList/{channelid}
  ?_isAgg=true&_isJson=true&_pageSize=40&_template=index&page=N
```

返回结构 `{data:{total, results:[{title, url, publishedTime,
resList:[{fileName,filePath}], domainMetaList:[{resultList:[{name,value}]}]}]}}`。
**注意**:不同局的字段落位不同——上海/深圳局把标题放顶层 `title`,
广东/河南局放 `resList.fileName`。解析器已做三级兜底。

已接入 **17 个地方证监局**的「监管措施」+「行政处罚」栏目(监管措施存量约 1.2 万条):

上海、广东、浙江、深圳、江苏、山东、四川、湖北、福建、天津、
重庆、河南、湖南、安徽、陕西、辽宁、北京

- 每局两个源:`csrc_{code}_mon`(监管措施,默认启用)、`csrc_{code}_pun`(行政处罚,
  默认启用,设 `CSRC_PUNISH=0` 可关)
- 私募过滤:地方局栏目混有大量上市公司/券商/期货案例,
  用 `is_private_fund_case()` 过滤(强信号词 + 私募管理人名称模式 + 排除词)
- 正文来源:① 网页正文(上海/深圳局) ② 附件 PDF/DOCX/DOC(其余局)——
  `_find_attachment_pdf()` 自动回退

**分页与回填(重要)**:
- 接口**硬顶每页 20 条**(`_pageSize` 传 40 也只回 20),`fetch_csrc_api` 的
  page_size 必须是 20,否则提前终止翻页(2026-09-22 踩坑,曾导致每局只采 20 条)
- 分页深度用环境变量注入:**日常默认 3 页**;深度回填时在进程内设
  `CSRC_PAGES`(监管措施页数)、`CSRC_PUNISH_PAGES`、`CSRC_MAIN_PAGES`(总会)、
  `AMAC_PAGES`(中基协),另可 `FETCH_INTERVAL=2` 放宽限速
- 已入库且有正文的记录自动跳过详情重抓(`prev_bodied` 集合),回填幂等可重复跑

### 三、证监会总会(同样走统一 JSON 接口,无需 Playwright)

| key | 来源 | channelid | 存量 |
|---|---|---|---|
| `csrc_main` | 证监会·行政处罚决定书 | `17d5ff2fe43e488dba825807ae40d63f` | 约 2041 条 |

**channelid 发现法(重要)**:`c101928`、`c101971` 这类是**内容目录编号**,不是频道 ID。
真正的 channelid 藏在**证监会首页** `https://www.csrc.gov.cn/csrc/index.shtml` 的
`zfxxgk_zdgk.shtml?channelid=<32位hex>` 链接里。首页同时列出了各类别:

| 类别 | 首页链接 | channelid |
|---|---|---|
| 行政处罚 | `/csrc/c101971/zfxxgk_zdgk.shtml` | `17d5ff2fe43e488dba825807ae40d63f` |
| 市场禁入 | `/csrc/c101972/zfxxgk_zdgk.shtml` | `3795869930ca4b70bf55469270a6e641` |
| 行政复议 | `/csrc/c101973/zfxxgk_zdgk.shtml` | `77f99322f83040edb548974091db3f8b` |
| 监管措施 | `/csrc/c100044/tz.shtml` | `212665889d144f0392445f47661ca98e` |

**字段落位**:总会返回顶层 `title` + `url`(形如 `//www.csrc.gov.cn/csrc/...`,协议相对,
须补 `https:`,已由 `_norm_csrc_url()` 处理) + `publishedTimeStr`。正文在 `div.detail-news`,网页直出。

**私募相关度提示**:总会行政处罚近期几乎全是内幕交易/上市公司财务造假
(当事人为自然人或不特定公司),私募管理人占比极低。仍保留 `kw=["private"]` 过滤,
实测 20 条 → 0 条属于正常结果,不是抓取失败。

### 四、栏目 channelid 如何获取

**地方局**:各局首页 → 找「监管措施」「行政处罚」链接 → 取 `channelid` 参数。
示例(上海局):`https://www.csrc.gov.cn/shanghai/c103876/zfxxgk_zdgk.shtml?channelid=9ebc4198232e496e8bebf1b1bb1778ef`

**总会**:见上表,从 `csrc/index.shtml` 提。

新增一个局的完整步骤:
1. 抓该局首页,正则找含「监管措施」的 `<a>` 标签,提取 `channelid`
   (通用正则:`zfxxgk_zdgk\.shtml\?channelid=([0-9a-f]{32})` 或 `tz\.shtml\?channelid=([0-9a-f]{32})`)
2. 在 `CSRC_OFFICES` 字典加一行:`"code": ("中文名", 监管措施channelid, 行政处罚channelid或None)`
3. 完成——`_build_csrc_sources()` 会自动生成源配置

**注意**:`SOURCES` 是模块级字典,若在文件后部再次赋值 `SOURCES["csrc_main"] = {...}`
会**覆盖**前部定义。修改源配置时务必全局搜索 key 名,确认没有第二处赋值。

## 关键实现知识(踩坑记录)

1. **中基协页面是双重编码**:字节流为 UTF-8,但内容被 latin-1 二次编码,页面显示乱码。
   `common.fix_encoding()` 先 UTF-8 解码,检测前 4000 字符中 å/ç/è/é 计数 >12 则做
   `decode('utf-8').encode('latin-1').decode('utf-8')` 修复。BOM 需先剥离。
2. **中基协单页多 tab**:党建动态/协会要闻/纪律处分/自律措施等全部塞在同一 HTML,
   用 `<!-- tab名 -->` 注释定位边界;「纪律处分」名在页面出现两次,机构/人员必须再用
   PDF 路径(`/scfjg/` vs `/scfry/`)区分,否则两源抓到同一批数据。
3. **中基协处分 PDF 是纯扫描件**:每页一张位图,零文本层,pypdf 恒返回空。
   三级抽取顺序:文本层(≥100字)→ OCR(腾讯云,需 TENCENT_SECRET_ID/KEY 环境;或本地 tesseract)→
   **agent 视觉转录**(默认兜底,见下节)。
4. **证监会总会列表曾是 JS 渲染,现已解决**:不必装 Playwright。
   正确姿势是从 `csrc/index.shtml` 解出真实 channelid(见上「三」节),再走统一 JSON 接口。
   老思路(`c101928` 等目录编号 + `csrc/searchList/...` 302 跳首页)已废弃。
5. **地方证监局是静态 HTML**:正文在 `div.detail-news`,标题规律
   「关于对XX采取出具警示函措施的决定」,当事人用 `关于对(.+?)(?:采取|出具)` 提取。
6. **附件后缀会骗人,必须嗅探文件头(重要)**:广东局把 `.docx`/`.doc` 挂在 `.pdf` 命名的
   链接下,旧代码按后缀送进 PDFium 直接崩:
   ```
   invalid pdf header: b'PK\x03\x04\n'          ← .docx (zip)
   invalid pdf header: b'\xd0\xcf\x11\xe0\xa1'  ← .doc (OLE2)
   ```
   解法:`_sniff_kind(data)` 按魔数分流 → `%PDF` 走 PDF 三级抽取;
   `PK\x03\x04` 走 `_extract_docx_text()`(解 zip → `word/document.xml` → 按
   `w:p`/`w:t` 重组段落,顺带取 header/footer);`\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1`
   走 `_extract_doc_text()`(优先 antiword,无则 UTF-16LE 片段扫描)。
   统一入口 `extract_attachment_text(url)`。修复后广东局 8 条正文从 0 补齐到 500+ 字。
7. **个人/机构判定**:「私募基金」「证券」是泛词,出现在所有处罚正文,不可作机构判据;
   用机构后缀词(有限公司/合伙企业等)+ 正文身份描述(男,1984年出生)+ 标题短姓名模式。
8. **增量去重 ID**:中基协 PDF 文件名(P02026…)全局唯一,直接用;其余用「来源+URL」MD5。
   台账 `data/ledger.json` 记录 first_seen,正文后到时可补全记录。
9. **相对链接拼接的文件名坑(2026-09-22)**:`_abs_url(base, href)` 的 base 若是页面文件
   (如中基协翻页的 `index_1.html`)而非目录,posixpath.join 会把文件名当目录,
   拼出 `scfry/index_1.html/202608/P....pdf` 的坏 URL → 详情全挂。
   已修:base 不以 / 结尾时先取所在目录再 join。
   台账若已混入坏 URL 记录(url 含 `/index_`),先按此特征清理再重跑回填(幂等)。
10. **条款号归属必须限位(锚点解读,2026-09-22)**:处罚原文用顿号串联多个法规,如
    「《若干规定》第十二条、《登记备案办法》第四条、《私募基金监管办法》第二十四条」。
    若对每个法规名单独在**全文**搜"第X条",会出现「《基金法》第二十四条」这类错配。
    正确做法见 `anchor.py: extract_law_anchors()`——把法规名按出现位置排序,
    第 i 名的归属区间 = `[pos_i, pos_{i+1})`,区间内条款号才归属它。
11. **个人当事人曾被抽成整套标题(2026-09-22)**:中基协标题「纪律处分决定书(胡逸之)」
    的抽取规则用括号匹配时,需**先剥掉文书名前缀**再取括号内容,否则 subject 变成
    「纪律处分决定书(胡逸之)」整串,进而污染案例法锚点的累犯识别(出现假阳性主体)。
    `common.extract_subject()` 已加规则 0 专治此形(66 条历史记录已回填修正)。
12. **正则禁用汉字区间**:`[四-八]` 这类写法在 Python re 中报
    `bad character range`——汉字的 Unicode 码点区间不连续,必须逐个枚举
    `第三十四条|第三十五条|…`。
13. **附件查找作用域别写窄(2026-09-30,重要)**:地方局附件有两个位置——
    `div id="files"`(多数局)与 **`div.detail-news` 正文容器内**(广东局)。
    `_find_attachment_pdf()` 原先只看前者,导致广东局附件永远找不到、
    「正文过短→取附件」的兜底形同虚设,案例正文长期为空。
    已改为三级回退:`id="files"` → `detail-news`(截到 `xxgk-down-box`)→ 全文。
14. **中文附件名 URL 必须 percent-encode(2026-09-30,重要)**:证监会地方局的附件名
    常含中文与`〔〕`(如 `关于对…的决定〔2026〕53号.docx`),把这种 URL 直接交给
    `urllib` 会抛 `UnicodeEncodeError: 'ascii' codec can't encode characters`。
    解法:拼好绝对 URL 后统一
    `quote(urlsplit(furl).path, safe="/%")` 再请求(保留已有 %XX)。
    修复后广东局 4 条正文从 0 补齐到 600-2300 字,台账 539 条正文完整率 100%。
15. **`.doc` 旧格式无 pywin32 的兜底**:本机未装 pywin32,`win32com` 不可用。
    退路:按 `utf-16-le` 解码字节流后按 CJK 字符集过滤,再定位「经查」锚点取正文,
    实测可用于判断书类文书。
16. **交付文件名与生成文件名要同步(2026-09-30,易误判为爬虫故障)**:
    `report.py` 写死输出 `output/penalties.html`,而用户看的是中文名交付文件
    `output/私募合规工作台·案例库+锚点解读+制度生成器+绩效分析.html`。
    两者不同步时,数据其实天天在涨,用户却发现页面内容不变,
    误以为"爬虫没更新案例"。已在 `bootstrap.py` 增加 `HTML_DELIVER` 自动复制,
    并在摘要打印「交付:」行。**绕过 bootstrap 直接跑 report.py 时务必手动补复制。**

17. **制度生成器内嵌进工作台(2026-09-30,改 `report.py` 前必读)**:
    第三个 Tab 由 `report.py` 的 `_load_generator()` 在**构建时**从
    `generator/output/私募证券基金管理人内控制度生成器.html` 现场抽取,注入
    模板占位符 `__GENCSS__`(样式)、`__GENBODY__`(面板 HTML)、
    `__GENDATA__`(法规/模块 JSON)、`__GENJS__`(主逻辑 JS,含 script 标签)。
    **用户硬要求:内嵌后的生成器必须与 1.2.0 独立单页"一模一样"**,因此:
    - **禁止改生成器的界面与逻辑**:不删 header、不删 #badge、不重写 reset
      (reset 保留原样的 `location.reload()`)。第一版曾删 header/`:root`/badge,
      导致配色错乱、标题徽章消失 —— 已回退,教训:内容一字不动。
    - **CSS 只做机械换名**(`_scope_generator_css()`):`:root{`→`#pGen{`、
      `body{`→`#pGen{`(变量挂到 #pGen 靠继承下发,不再覆盖工作台 :root),
      其余每个选择器加 `#pGen ` 前缀;**声明一字不动**。
    - **JS 唯一改动**:2 处 `document.querySelectorAll(".tabs button")` 收窄为
      `#pGen .tabs button` —— 否则生成器内部切换会清掉工作台顶栏高亮。
      在独立单页里命中集合不变,行为等价。
    - **工作台一侧反向收窄**(双向隔离,缺一不可):`.wrap/.sub/.tabs/.tab/.pane/
      table/thead th/tbody td/.badge` 等宽选择器全部限定到工作台自身结构
      (如 `body>.wrap>.pane`、`:where(#pCases,#pKb) tbody td`),否则
      `.pane{display:none}` 会把生成器左栏藏掉、table 边框会画到生成器表格上。
      用 `:where()` 包裹以保持原有优先级,不影响内部级联。
    - **JS 必须连 `<script>` 标签一起提取**(曾只取内容导致裸 JS 拼进工作台
      脚本块,整个生成器不执行,badge 停在"加载中")。
    - **id 唯一性**:生成器 28 个 id 在工作台内唯一,`getElementById` 照常用。
    改完**务必跑 `python scripts/report.py` 重建**,用 Chrome 无头截图对比
    `generator/output/` 独立页,确认四 Tab 可切、左栏表单可见、
    「生成诊断与制度」能出正文、badge 显示"法规 186 条 / 模块 36 个"。

### 18. bootstrap 曾把列表请求跑两遍,白烧一半时间(2026-09-30 修正)

`bootstrap.py` 第 1 步原先是「先跑 `fetch.py --list-only` 作探测 → 再跑完整 `fetch.py`」。
**误以为 `--list-only` 只采列表所以很快——实测完全不是。**

实测数据(2026-09-30,同一台机器,三次独立运行):

| 命令 | 实测耗时 | 说明 |
|---|---|---|
| `fetch.py --list-only` | **359s** | 照样走完 36 源 × 3 页 = 104 次请求 |
| `fetch.py`(完整) | **364s** | 列表 104 次 + 详情 33 次(539 条台账已 bodied,详情几乎不新增) |
| `bootstrap.py`(修正前) | **727s** | 列表请求做了两遍 = 359 + 364 |
| `bootstrap.py`(修正后) | **360s** | 只跑一次完整采集 |

**根因**:耗时几乎全在 `common.REQUEST_INTERVAL`(默认 3.0s)的限速上,
104 次列表请求 × 3s ≈ 312s,是硬地板。`--list-only` 省掉的只是详情请求,
而详情请求因为台账已 bodied(增量跳过)本来就只有 5 秒 —— 所以两个命令耗时几乎相同。

**修正**:删掉 `--list-only` 探测,只跑一次完整 `fetch.py`。失败情况由 rc 与日志尾部体现。

**教训**:`--list-only` / `--limit` 这类"快速模式"参数,在**列表遍历本身才是瓶颈**时毫无意义。
判断某步是否值得做,要看它的**请求次数**,不是看名字里的"only"。
若要真正提速,方向是降低 `FETCH_INTERVAL` 或 `CSRC_PAGES`/`CSRC_PUNISH_PAGES`,
而不是拆成两个命令跑。

### 19. 转录稿写回的时序铁律:视觉转录发生在 bootstrap 之后,必须重跑 ocr_apply(2026-10-08)

`ocr_apply.py` 把 `data/ocr_queue/<uid>/transcript.txt` 写回台账(`body_status` 置 `ok`)。
**它只在被显式调用时才跑,自己不会触发。** 一旦转录稿与写回/重建脱节,台账就永远停在 `pending_ocr`。

2026-10-08 的真实事故链:

| 时间 | 事件 |
|---|---|
| 09:20 | `fetch.py` 把扫描件 PDF 渲染成 `page_N.png` 入队,标记 `pending_ocr` |
| 09:26 | 当日 09:00 定时任务的 `bootstrap.py` 跑完,但此时 transcript 还不存在 → `ocr_apply.py` 写回 0 条 |
| 09:31~09:44 | 转录稿才被逐条写入磁盘(24 条) |
| 之后 | **没人重跑 `ocr_apply.py` + 重建** → 台账 564 条里 24 条停在 `pending_ocr`,网页显示"待转录" |

表现:`ocr_queue/` 下已有 23+ 个 `transcript.txt`,但 `ledger.json` 仍是 `pending_ocr`
—— 磁盘有稿、台账没回写。**这不是 `ocr_apply.py` 的 bug,是少了一次触发。**

**铁律(谁补写 transcript 谁负责收尾):**

> 凡新增或补写 `data/ocr_queue/<uid>/transcript.txt`,必须随后紧接着执行:
> ```
> "<PY>" ocr_apply.py          # 写回台账(body_status → ok)
> "<PY>" bootstrap.py --quick  # 重建网页/简报(不可省,否则网页仍是旧状态)
> ```

- 定时任务 prompt 第 3 步虽已写明该顺序,但**实际执行时极易漏掉收尾**——
  视觉转录做完就结束,忘了 ocr_apply 与重建。务必把这两步当成交付 Checklist 的最后两项。
- 自查口径:**`ledger.json` 的 `body_status` 以 `pending_ocr` 开头的条数应为 0**;
  若大于 0,先看 `ocr_queue/` 下同名目录是否已有 `transcript.txt`——
  有就直接跑上面两步收尾,不必重新读图。

**潜在限制(当前无实例,留作提醒):** `ocr_apply.py` 取 uid 只认 `rec["url"]` 的 basename
(`if not u.endswith(".pdf"): continue`)。若将来出现「页面 URL 是 `.shtml`、正文在
`rec["attachment"]` 指向的 PDF 里」的扫描件,该条目会被跳过、永远写不回。
届时在 `ocr_apply.py` 的候选 uid 里补一句"若 `attachment` 以 `.pdf` 结尾也取其 basename"即可。

### 20. 绩效分析平台内嵌进工作台:用 iframe srcdoc,不要 CSS 收拢(2026-10-08)

第四个 Tab「绩效分析」是独立的 React + Tailwind SPA 单页
(`performance/output/绩效分析平台.html`,全内联、无 `./assets` 外链)。
**内嵌方式选了 iframe `srcdoc`,而不是像制度生成器那样用选择器加 `#pPerf` 前缀收拢。**

- **为什么不用 CSS 收拢**:Tailwind 是「构建期抽取」的原子类(`.flex`/`.p-4`/`.text-sm`…),
  成千上万个全局类 + 自己的 `:root` 变量体系。逐行机械换名只能处理顶层规则,
  **`@media` / 伪类内层的选择器漏收 → 变成全局类污染工作台**;反之工作台自己的
  `.card`/`.tab` 若同名也会进 SPA。两条路都会"破相"。
- **iframe 的好处**:SPA 处于「另一个文档」,样式与脚本天然零交叉 —— 既满足
  "原封不动",又满足"不破坏原有平台页面和数据"两条硬要求。
- **转义规则**(属性值以双引号定界,`_load_performance()` 已实现):`&`→`&amp;`、
  `"`→`&quot;`;`</iframe` 防御性改写为 `<\/iframe`(避免极少数情况下提前闭合)。
  换行在属性值中合法,无需转义。浏览器解析 srcdoc 时会自动还原实体,内容与独立单页逐字节一致。
- **校验**:跑 `python scripts/report.py` 重建后,用 Chrome 无头加载
  `output/私募合规工作台·…绩效分析.html`,确认四 Tab 可切、切到绩效分析时
  `perfFrame.contentDocument` 的 `#root` 已被 React 挂载(子节点 > 0),
  且切回案例库后 564 条文案仍正常(确保工作台未被 SPA 拖垮)。

## Agent 视觉转录流程(核心工作流)

扫描件 PDF 无 OCR 后端时,fetch.py 自动把页面渲染为 PNG 并入队:
`data/ocr_queue/<PDF文件名>/page_1.png, page_2.png, …`

**agent 转录步骤**(每次 fetch 后执行):

1. 列出 `data/ocr_queue/*/`,找出有 `page_*.png` 但无 `transcript.txt` 的目录
2. 用 Read 工具逐页读取 PNG(多模态),将全文转录
3. 写入同目录 `transcript.txt`(纯文本,保留章节结构)
4. 跑 `python scripts/ocr_apply.py` 把 transcript.txt 挂回台账
   (`extract_method=agent_vision`,`body_status=ok`),幂等可反复运行

**批量转录**:每个子代理分配 10 项左右,并行推进;单项超过 6 页可只转录前 5 页
(基本事实与处分决定通常在前几页)。全部完成后统一跑 `ocr_apply.py`。

**转录规范**(原文照搬,一字不改):保留文书结构——标题 / 文号(如「中基协处分〔2026〕14号」)/
当事人段 / 基本事实 / 审理意见 / 处分决定 / 落款(协会名+日期) / 抄送行;
去掉页眉页脚与页码;表格内容一行一条平铺;跨页内容拼接;**不加任何 AI 评论或总结**。

**转录稿存放**:`data/transcripts/<uid>.txt` 是扁平化备份(与 `ocr_queue/<uid>/transcript.txt` 内容相同)。
`ocr_apply.py` 两处都读,所以在清理页面图后仍可正常写回。
> 交付前建议清理 `data/ocr_queue/**/page_*.png`(数百 MB)与 `data/cache/`(可重建),
> 转录文字已永久保存在 `data/transcripts/` 与台账 `body` 字段,不会丢失。

## 使用方法

```bash
# ★ 打开即更新(每次加载 skill 先跑这个)
python scripts/bootstrap.py

# 离线模式:不联网,只重建索引与产物
python scripts/bootstrap.py --quick

# 单独采集(全部源,增量)
python scripts/fetch.py

# 快速验证:只采列表不抓正文
# ⚠ 实测 359s,不比完整采集快多少(瓶颈是列表请求数而非详情),仅用于排查列表解析
python scripts/fetch.py --list-only

# 调试:限制每源详情数 / 指定源(这个能真正省时间:--limit 5 只抓 5 条详情)
python scripts/fetch.py --limit 5 --source amac_org

# 重建知识库索引(改了 references/ 后跑)
python scripts/kb_index.py

# 生成报告(简报窗口默认近7天);同时重建网页
python scripts/report.py --days 30

# 独立自检锚点引擎(法规命中率 + 累犯主体清单)
python scripts/anchor.py

# 把扫描件转录稿写回台账(幂等,可反复跑)
python scripts/ocr_apply.py

# 发布当日简报
python scripts/publish.py
```

依赖(已装):pypdf、pypdfium2、python-docx。可选:playwright、pytesseract。

**锚点解读与知识库索引均为纯本地计算**(无网络请求、无外部依赖),
`report.py` 每次运行都会重算并嵌入网页,所以台账或 references 一更新、重跑 report.py 即可刷新全部内容。

## 触发词与自动任务(重要)

### 一、用户请求"每天更新案例库 / 每天发简报"时 —— 立即执行以下动作

当用户说出下列任一意图时,**不要只回答,要直接创建每日定时任务**:

> "每天早上9点爬虫后更新工作台上的案例库" / "给我每天发一份监管案例" /
> "每天发一份处罚简报" / "定期推送监管动态" / "每天更新一下案例库" / "把这个做成每天自动的"

执行步骤:

1. 调用 `automation_update` 创建**每日 09:00** 的循环任务,字段如下:
   - `name`: 私募监管案例库每日9点更新
   - `scheduleType`: recurring
   - `rrule`: `FREQ=DAILY;BYHOUR=9;BYMINUTE=0`(每工作日跑就换成
     `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0`)
   - `cwds`: 当前会话工作目录即可(任务用绝对路径执行,不依赖 cwd)
   - `prompt`: 见本节"二、自动任务执行指令",原样填入
2. **创建前先 `automation_update` 列出全部任务,检查是否已有 09:00 的同类任务。**
   若已存在,**改用 `mode="update"`** 更新,不要重复创建。
   ⚠ **一个工作台只应有一个 9:00 任务。** 曾出现两个任务(「私募监管案例库每日9点更新」
   与「私募监管处罚每日简报」)同时跑,重复占用 6 分钟网络采集,且旧任务绕过
   `bootstrap.py` 直连 `fetch.py`+`report.py`,导致推送出去的页面缺交付副本同步。
   2026-09-30 已删除旧任务,只保留前者。
3. 创建后向用户确认:任务名、执行时间、产出物(工作台网页 + 当日简报 DOCX)。
4. 用户若改时间/改频率,同样用 `mode="update"` 只改对应字段。

### 二、自动任务执行指令(填入 automation 的 prompt)

```
运行私募合规工作台的每日增量更新,把最新监管处罚案例同步进案例库网页。

执行步骤(全部用 Bash 工具,命令前加 export PATH="/usr/bin:/bin:$PATH"):
1. cd 到 scripts 目录,执行完整增量更新(含联网采集):
   cd "<SKILL>/scripts"
   "<PY>" bootstrap.py
   注意:不要加 --quick(--quick 只重建产物不联网采集)。
   **超时设 900 秒以上**(实测总耗时约 360s,其中采集占 357s;留足余量)。

2. 检查输出末尾摘要,重点看:
   - 「台账: N 条 (新增 +X)」—— 新增案例数
   - 「正文完整 N | 待转录 N | 失败 N」—— 正文完整数应等于台账总数
   - 「交付: ...」—— 确认中文交付名文件已同步

3. 若「待转录」> 0:查看 data/ocr_queue 下新增目录,读其中的 page_*.png 图片,
   用视觉能力逐页转录为文字,写入 data/ocr_queue/<uid>/transcript.txt,再执行:
   "<PY>" ocr_apply.py
   然后重跑 bootstrap.py --quick 重建产物。

4. 若「失败」> 0 或某条正文为空:读 data/ledger.json 找出 body 为空的记录及 url。
   这些通常是证监会地方局页面,正文放在 div.detail-news 内的 .docx/.doc 附件里。
   抓该页面 HTML,正则提取 href 指向的 .docx/.doc/.pdf,拼绝对 URL,
   并**对 URL 路径做 percent-encode**(中文文件名必须编码,否则报 UnicodeEncodeError),
   下载后用 zipfile 读 word/document.xml 提取正文。
   写回 ledger.json 的 body 字段,置 extract_method="agent_vision"、body_status="ok",
   文本另存 data/transcripts/<uid>.txt。再跑 bootstrap.py --quick 重建。

5. 完成后向用户报告:新增条数与来源辖区、台账总数、正文完整率、交付文件完整路径。

关键约束:
- 绝对不要用 --force 或任何删除操作,data/ 与 output/ 是历史积累的运行数据。
- 交付文件是 output/私募合规工作台·案例库+锚点解读+制度生成器.html,bootstrap.py 自动同步它。
- 采集失败不要中断,bootstrap.py 会用现有台账继续重建产物,如实报告失败原因。
- 若窗口内无新增,明确说明"今日无新增案例",绝不编造案例内容。
```

其中 `<PY>` = `C:\Users\admin\.workbuddy\binaries\python\versions\3.13.12\python.exe`,
`<SKILL>` = `C:\Users\admin\.workbuddy\skills\@user_e7ed2541\quantmaloutuo`。

### 三、手动触发单次运行

用户说"现在跑一次监管案例"时,执行 `bootstrap.py`(需联网)或 `bootstrap.py --quick`(离线重建),
再用 `present_files` 推送 `output/私募合规工作台·案例库+锚点解读+制度生成器.html`
与 `output/briefing_<YYYYMMDD>.docx`。

### 四、产物名同步(易踩坑,勿删)

`report.py` 生成的网页写死为 `output/penalties.html`,而交付给用户的是中文名
`output/私募合规工作台·案例库+锚点解读+制度生成器.html`。
`bootstrap.py` 末尾会自动把前者复制到后者(`HTML_DELIVER` 常量),并在摘要打印「交付:」行。

**若绕过 bootstrap 直接跑 report.py,中文交付名文件不会更新** —— 用户会看到旧内容,
误以为"爬虫没抓到新案例"。此时手动补一次复制即可。

## 台账字段

| 字段 | 说明 |
|------|------|
| uid | 唯一ID(PDF文件名或URL哈希) |
| date | 公告日期(列表月日+参考年份补全) |
| source / source_key | 来源名称 / 配置键 |
| title / subject | 公告标题 / 当事人 |
| region / status | 辖区 / 机构或个人 |
| tags | 违规类型(登记备案/募集与适当性/投资运作/信息披露/内控与治理/侵占挪用/从业资格/其他) |
| measures | 处分措施(撤销管理人登记/暂停备案/公开谴责/警告/责令改正/罚款/市场禁入等) |
| amount_wan | 罚没金额(万元,取文中最大值) |
| summary | 自动摘要(定位"经查/经查明/我局发现"起) |
| body / extract_method / body_status | 正文 / 抽取方式(text_layer/ocr/agent_vision/html) / 状态 |
| url / first_seen / is_new | 原文链接 / 首次发现 / 本轮新增 |

## 合规边界

- 仅采集政务公开信息,遵守 robots.txt 精神:限速 3 秒/请求、单线程、真实 UA、不绕过验证码;
- 每日一次增量采集的规模对官网无压力;
- 台账与报告供内部合规研究,不对外分发原始文书,转载注明来源。

## 问答库合并说明(已完成)

本技能工作台**覆盖"规则 + 事实"两个维度**:

- **栏目 A 案例库** = 事实层(谁被罚了、罚了什么、援引哪条、是否累犯);
- **栏目 B 问答库** = 规则层(该怎么做、依据哪条、踩坑在哪);
- **栏目 C 制度生成器** = 落地层(按组织架构生成全套内控制度,附法规出处);
- **栏目 D 绩效分析** = 分析层(投资人/产品绩效的 React 单页,iframe 内嵌);
- 四者在网页同一份 HTML 内以四个 Tab 并列,可交叉使用:
  看到某案例的法规条款锚点 → 切到问答库按法规名/主题检索对应实操场景;
  在问答库读到某场景 → 切到案例库按违规类型检索同类的真实处罚事实。
- 知识库原文保留在 `references/`,是唯一事实来源,`kb_index.py` 只做结构化索引,**不改写任何原文**。

## 回答规范

使用简体中文。输出报告时先给结论(新增 N 条、重点案例),再给清单。
字段抽取不确定时如实标注状态,不编造。
