/**
 * 复权引擎自测：分红 / 拆分识别、三种复权口径、不复权低估幅度。
 * 运行：node scripts/test-adjust.mjs
 */
import { loadModule } from './_load.mjs';

const A = await loadModule('src/lib/adjust.ts', 'adjust');
const { detectActions, buildAdjusted, totalReturns, summarize, navOf } = A;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** 构造 NavPoint：rows = [date, unit, accum] */
const P = (rows) => rows.map(([d, u, a]) => ({ date: d, unitNav: u, accumNav: a, adjNav: a }));

/* ---------- 1. 无分红：三种口径一致 ---------- */
{
  console.log('\n[1] 无分红：三种复权口径结果一致');
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 1.01, 1.01],
    ['2024-01-03', 1.02, 1.02],
  ]);
  const acts = detectActions(pts);
  ok('未识别出公司行为', acts.length === 0, JSON.stringify(acts));

  const none = buildAdjusted(pts, 'none', acts);
  const back = buildAdjusted(pts, 'backward', acts);
  const fwd = buildAdjusted(pts, 'forward', acts);

  ok('不复权 = 累计净值', near(navOf(none[2]), 1.02));
  ok('向后复权末点 = 1.02', near(navOf(back[2]), 1.02), String(navOf(back[2])));
  ok('向后复权起点 = 期初单位净值', near(navOf(back[0]), 1.0));
  ok('向前复权末点 = 期末单位净值', near(navOf(fwd[2]), 1.02));
  // 无分红时复权净值即单位净值序列，向后与向前完全一致
  ok('无分红时向后＝向前复权序列', near(navOf(fwd[0]), navOf(back[0]), 1e-12), `${navOf(fwd[0])} vs ${navOf(back[0])}`);

  // 三种口径收益率序列一致
  const rNone = navOf(none[2]) / navOf(none[0]) - 1;
  const rBack = navOf(back[2]) / navOf(back[0]) - 1;
  const rFwd = navOf(fwd[2]) / navOf(fwd[0]) - 1;
  ok('三口径区间收益一致', near(rNone, rBack, 1e-12) && near(rBack, rFwd, 1e-12), `${rNone}/${rBack}/${rFwd}`);
}

/* ---------- 2. 有分红：不复权会低估 ---------- */
{
  console.log('\n[2] 有分红：不复权低估收益，复权还原真实回报');
  // 1.0 →（每份分红 0.1，单位净值 1.0→0.9，累计净值保持 1.0）→ 次日 +1%
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 0.9, 1.0],   // 分红日
    ['2024-01-03', 0.909, 1.009],
  ]);
  const acts = detectActions(pts);
  ok('识别出 1 次分红', acts.length === 1 && acts[0].type === 'dividend', JSON.stringify(acts));
  ok('分红金额 = 0.1', near(acts[0].value, 0.1, 1e-9), String(acts[0].value));
  ok('分红日期正确', acts[0].date === '2024-01-02', acts[0].date);

  const r = totalReturns(pts, acts);
  ok('分红日收益率 = 0', near(r[1], 0), String(r[1]));
  ok('次日收益率 = 1%', near(r[2], 0.01, 1e-9), String(r[2]));

  const back = buildAdjusted(pts, 'backward', acts);
  ok('向后复权：分红日净值不跌', near(navOf(back[1]), navOf(back[0]), 1e-9), `${navOf(back[1])}`);
  ok('向后复权：末点 = 1.01', near(navOf(back[2]), 1.01, 1e-9), String(navOf(back[2])));

  const s = summarize(pts, acts);
  ok('不复权区间收益 = 0.9%', near(s.rawReturn, 0.009, 1e-9), String(s.rawReturn));
  ok('复权区间收益 = 1%', near(s.adjustedReturn, 0.01, 1e-9), String(s.adjustedReturn));
  ok('复权 > 不复权（不复权低估）', s.adjustedReturn > s.rawReturn, `${s.adjustedReturn} vs ${s.rawReturn}`);
  ok('差异被标记', s.hasDifference === true);
  ok('期初存量分红 = 0', near(s.openingDividend, 0));
  ok('区间新增分红 = 0.1', near(s.periodDividend, 0.1, 1e-9), String(s.periodDividend));
}

/* ---------- 3. 向后 / 向前复权收益率相同，仅基准不同 ---------- */
{
  console.log('\n[3] 向后 vs 向前复权：收益率相同、净值基准不同');
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 0.9, 1.0],
    ['2024-01-03', 0.909, 1.009],
    ['2024-01-04', 0.92, 1.02],
  ]);
  const acts = detectActions(pts);
  const back = buildAdjusted(pts, 'backward', acts);
  const fwd = buildAdjusted(pts, 'forward', acts);

  ok('向后复权起点 = 期初单位净值', near(navOf(back[0]), 1.0), String(navOf(back[0])));
  ok('向前复权终点 = 期末单位净值', near(navOf(fwd[3]), 0.92), String(navOf(fwd[3])));
  ok('区间收益相同',
    near(navOf(back[3]) / navOf(back[0]), navOf(fwd[3]) / navOf(fwd[0]), 1e-12),
    `${navOf(back[3]) / navOf(back[0])} vs ${navOf(fwd[3]) / navOf(fwd[0])}`);
}

/* ---------- 4. 拆分识别与修正 ---------- */
{
  console.log('\n[4] 份额拆分：识别并修正，不产生虚假收益');
  // 有存量分红时，拆分会让单位净值与累计净值同比例跳变
  const pts = P([
    ['2024-01-01', 2.0, 2.2],   // 累计分红 0.2
    ['2024-01-02', 1.01, 1.111], // 1 拆 2 且当日涨 1%
  ]);
  const acts = detectActions(pts);
  ok('识别出 1 次拆分', acts.length === 1 && acts[0].type === 'split', JSON.stringify(acts));
  ok('拆分因子 = 2', near(acts[0].value, 2, 1e-9), String(acts[0].value));
  const r = totalReturns(pts, acts);
  ok('拆分日收益率 ≈ 1%（拆分本身不产生收益）', Math.abs(r[1] - 0.01) < 1e-4, String(r[1]));

  const back = buildAdjusted(pts, 'backward', acts);
  ok('复权净值连续上涨', navOf(back[1]) > navOf(back[0]), `${navOf(back[1])} vs ${navOf(back[0])}`);
}

/* ---------- 5. 无分红产品的单日大跌不得误判为拆分 ---------- */
{
  console.log('\n[5] 无分红时单日大跌不误判为拆分');
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 0.88, 0.88],  // 单日 -12%
  ]);
  const acts = detectActions(pts);
  ok('无存量分红 + 非干净比例 → 不判拆分', acts.length === 0, JSON.stringify(acts));

  // 精确腰斩且落在干净比例上 → 判为拆分（可由人工忽略）
  const pts2 = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 0.5, 0.5],
  ]);
  const acts2 = detectActions(pts2);
  ok('干净比例 0.5 → 判为拆分', acts2.length === 1 && acts2[0].type === 'split', JSON.stringify(acts2));
}

/* ---------- 6. 忽略事件后重算 ---------- */
{
  console.log('\n[6] 忽略事件后按剩余事件重算');
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 0.9, 1.0],
    ['2024-01-03', 0.909, 1.009],
  ]);
  const acts = detectActions(pts);
  const withDiv = summarize(pts, acts);
  const ignored = summarize(pts, []);
  // 忽略分红后，复权退化为单位净值口径：分红跳空被算作 -10% 亏损
  ok('忽略后复权收益 = -9.1%', near(ignored.adjustedReturn, -0.091, 1e-9), String(ignored.adjustedReturn));
  ok('忽略前复权收益 = +1%', near(withDiv.adjustedReturn, 0.01, 1e-9), String(withDiv.adjustedReturn));
  ok('忽略前后结果不同', !near(ignored.adjustedReturn, withDiv.adjustedReturn, 1e-9));
  const backIgnored = buildAdjusted(pts, 'backward', []);
  ok('忽略后按单位净值涨跌计算（含分红跳空的那天会被算成 -10%）',
    near(navOf(backIgnored[1]), 0.9), String(navOf(backIgnored[1])));
}

/* ---------- 7. 恒定偏移不产生分红事件 ---------- */
{
  console.log('\n[7] 累计净值与单位净值恒定差额 → 不误报分红');
  const pts = P([
    ['2024-01-01', 1.0, 1.3],
    ['2024-01-02', 1.01, 1.31],
    ['2024-01-03', 1.02, 1.32],
  ]);
  const acts = detectActions(pts);
  ok('无分红事件', acts.filter((a) => a.type === 'dividend').length === 0, JSON.stringify(acts));
  const s = summarize(pts, acts);
  ok('期初存量分红 = 0.3', near(s.openingDividend, 0.3, 1e-9), String(s.openingDividend));
}

/* ---------- 8. 多次分红累计 ---------- */
{
  console.log('\n[8] 多次分红累计还原');
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 0.95, 1.0],   // 分红 0.05
    ['2024-01-03', 1.0, 1.05],   // 涨回，累计 1.05
    ['2024-01-04', 0.90, 1.05],  // 再分红 0.10
    ['2024-01-05', 0.99, 1.14],
  ]);
  const acts = detectActions(pts);
  ok('识别出 2 次分红', acts.filter((a) => a.type === 'dividend').length === 2, JSON.stringify(acts));
  const s = summarize(pts, acts);
  ok('累计分红 = 0.15', near(s.periodDividend, 0.15, 1e-9), String(s.periodDividend));
  const back = buildAdjusted(pts, 'backward', acts);
  // 复权期末 = 1.0 × (1+0) × (1+0.0526...) × ... 手工核对：全收益连乘
  const expected = ((0.95 + 0.05) / 1.0) * (1.0 / 0.95) * ((0.90 + 0.10) / 1.0) * (0.99 / 0.90);
  ok('复权期末与手工连乘一致', near(navOf(back[4]) / navOf(back[0]), expected, 1e-12),
    `${navOf(back[4]) / navOf(back[0])} vs ${expected}`);
  ok('复权收益高于不复权', s.adjustedReturn > s.rawReturn, `${s.adjustedReturn} vs ${s.rawReturn}`);
}

/* ---------- 9. 复利复权（行业口径）---------- */
{
  console.log('\n[9] 复利复权：复权净值 = 单位净值 × ∏(分红前 ÷ 分红后)');
  // 分红前（除息日前一交易日）1.15，单位分红 0.15 → 分红后 1.00
  // 约定"先除息后计损益"：当日涨 1% → 除息后单位净值 1.00 × 1.01 = 1.01
  const pts = P([
    ['2024-01-01', 1.15, 1.15],
    ['2024-01-02', 1.01, 1.16],   // 除息日，累计分红 0.15
    ['2024-01-03', 1.0201, 1.1701], // 再涨 1%
  ]);
  const acts = detectActions(pts);
  ok('识别出 1 次分红', acts.length === 1 && acts[0].type === 'dividend', JSON.stringify(acts));
  ok('分红金额 = 0.15', near(acts[0].value, 0.15, 1e-9), String(acts[0].value));

  const f = A.compoundFactors(pts, acts);
  ok('期初因子 = 1', near(f[0], 1), String(f[0]));
  ok('除息日因子 = 1.15/1.00', near(f[1], 1.15, 1e-9), String(f[1]));
  ok('因子此后保持不变', near(f[2], f[1]), String(f[2]));

  const comp = buildAdjusted(pts, 'compound', acts);
  ok('期初复权净值 = 期初单位净值', near(navOf(comp[0]), 1.15), String(navOf(comp[0])));
  ok('除息日复权净值 = 1.01 × 1.15', near(navOf(comp[1]), 1.1615, 1e-9), String(navOf(comp[1])));
  ok('次期复权净值 = 1.0201 × 1.15', near(navOf(comp[2]), 1.173115, 1e-9), String(navOf(comp[2])));

  // 该约定下复利复权的日收益率 = 除息后资产的价格收益率 1%
  ok('除息日收益率 = 1%', near(navOf(comp[1]) / navOf(comp[0]) - 1, 0.01, 1e-9),
    String(navOf(comp[1]) / navOf(comp[0]) - 1));
  ok('次期收益率 = 1%', near(navOf(comp[2]) / navOf(comp[1]) - 1, 0.01, 1e-9),
    String(navOf(comp[2]) / navOf(comp[1]) - 1));

  // 与向后复权对照：同一约定下向后复权偏低（分红按期末净值再投资）
  const back = buildAdjusted(pts, 'backward', acts);
  const compRet = navOf(comp[2]) / navOf(comp[0]) - 1;
  const backRet = navOf(back[2]) / navOf(back[0]) - 1;
  ok('复利复权 > 向后复权（本约定下）', compRet > backRet, `${compRet} vs ${backRet}`);
  ok('向后复权 = (1.16+0.15)/1.15 ... 逐期连乘', backRet > 0, String(backRet));

  const s = summarize(pts, acts, 'compound');
  ok('summarize 复利口径收益 = 2.01%', near(s.adjustedReturn, 0.0201, 1e-9), String(s.adjustedReturn));
  ok('summarize 同时给出向后口径', near(s.backwardReturn, backRet, 1e-12), String(s.backwardReturn));
  ok('不复权收益最低', s.rawReturn < s.adjustedReturn, `${s.rawReturn} vs ${s.adjustedReturn}`);
}

/* ---------- 10. 复利复权下的拆分 ---------- */
{
  console.log('\n[10] 复利复权：拆分同乘拆分因子');
  // 有存量分红 0.2，1 拆 2 且当日涨 1%
  const pts = P([
    ['2024-01-01', 2.0, 2.2],
    ['2024-01-02', 1.01, 1.111],
  ]);
  const acts = detectActions(pts);
  ok('识别出拆分', acts.length === 1 && acts[0].type === 'split', JSON.stringify(acts));
  const comp = buildAdjusted(pts, 'compound', acts);
  // 复权净值 = 1.01 × 2 = 2.02，相对期初 2.0 涨 1%
  ok('复权期末 = 2.02', near(navOf(comp[1]), 2.02, 1e-9), String(navOf(comp[1])));
  ok('收益率 = 1%（拆分不产生收益）', near(navOf(comp[1]) / navOf(comp[0]) - 1, 0.01, 1e-9),
    String(navOf(comp[1]) / navOf(comp[0]) - 1));
}

/* ---------- 11. 无分红时四种口径一致 ---------- */
{
  console.log('\n[11] 无分红：四种口径收益一致');
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 1.01, 1.01],
    ['2024-01-03', 1.02, 1.02],
  ]);
  const modes = ['compound', 'backward', 'forward', 'none'];
  const rets = modes.map((m) => {
    const a = buildAdjusted(pts, m, []);
    return navOf(a[2]) / navOf(a[0]) - 1;
  });
  ok('四口径收益相同', rets.every((r) => near(r, rets[0], 1e-12)), JSON.stringify(rets));
  const comp = buildAdjusted(pts, 'compound', []);
  ok('复利复权净值 = 单位净值', near(navOf(comp[2]), 1.02), String(navOf(comp[2])));
}

/* ---------- 12. 边界：分红额接近净值时不崩 ---------- */
{
  console.log('\n[12] 边界：分红后净值非正时跳过该笔');
  const pts = P([
    ['2024-01-01', 1.0, 1.0],
    ['2024-01-02', 0.1, 1.0],  // 分红 0.9 → 分红后 0.1
    ['2024-01-03', 0.101, 1.001],
  ]);
  const acts = detectActions(pts);
  const comp = buildAdjusted(pts, 'compound', acts);
  ok('因子有限且为正', comp.every((p) => Number.isFinite(navOf(p)) && navOf(p) > 0),
    JSON.stringify(comp.map(navOf)));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
