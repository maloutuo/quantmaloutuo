import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Upload, Table2, Sparkles, FileUp, FileSpreadsheet, ClipboardPaste, X } from 'lucide-react';
import {
  analyzeSheet, readWorkbooks, readWorkbookFromText,
  type SheetAnalysis, type WorkbookData, type Orientation, type AnalyzeOverrides,
} from '@/lib/excel';
import { buildProducts, type ImportMode } from '@/lib/products';
import { deriveProductName } from '@/lib/naming';
import type { AnnualMode } from '@/lib/perf';
import type { Product } from '@/types';

interface Props {
  products: Product[];
  rf: number;
  annualMode: AnnualMode;
  onRfChange: (rf: number) => void;
  onAnnualModeChange: (mode: AnnualMode) => void;
  onAdd: (list: Product[]) => void;
  onLoadSample: () => void;
}

interface ParsedSource {
  fileName: string;
  analyses: SheetAnalysis[];
}

const SAMPLE_TEXT = `日期,单位净值,累计净值
2024-01-02,1.0120,1.0520
2024-01-03,1.0155,1.0558
2024-01-04,1.0098,1.0499`;

const SAMPLE_WIDE = `净值日期,示例一号,示例二号,示例一号
2024-01-02,1.0000,1.0000,1.0000
2024-01-03,1.0031,0.9982,1.0124
2024-01-04,1.0082,1.0044,1.0201`;

export function ImportSection({
  products, rf, annualMode, onRfChange, onAnnualModeChange, onAdd, onLoadSample,
}: Props) {
  const [paste, setPaste] = useState('');
  const [sources, setSources] = useState<ParsedSource[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [overrides, setOverrides] = useState<AnalyzeOverrides>({});
  const [axes, setAxes] = useState<number[]>([]);
  const [mode, setMode] = useState<ImportMode>('auto');
  const [errors, setErrors] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const cur = sources[fileIdx]?.analyses[sheetIdx] ?? null;

  /** 当前工作表在（可能被人工调整过的）版面参数下的分析结果 */
  const analysis = useMemo(() => {
    if (!cur) return null;
    return analyzeSheet({ name: cur.sheetName, rows: cur.rows }, cur.fileName, overrides);
  }, [cur, overrides]);

  /** 识别出的产品名（全称 / 简称 / 代码），用于在导入前就确认显示名 */
  const nameInfo = useMemo(() => {
    if (!analysis) return null;
    const m = deriveProductName(analysis.rows, analysis.fileName);
    return m.short ? m : null;
  }, [analysis]);

  // 切换工作表 / 版面参数后，重置选中数值轴为全部识别结果
  const valueAxes = analysis?.valueAxes ?? [];
  const valueKey = valueAxes.map((a) => a.index).join(',');
  useEffect(() => {
    setAxes(valueKey ? valueKey.split(',').map(Number) : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey, fileIdx, sheetIdx]);

  const loadFiles = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    const errs: string[] = [];
    const infos: string[] = [];
    const parsed: ParsedSource[] = [];
    for (const f of list) {
      try {
        // 压缩包会自动展开，包内每个 Excel / CSV 各成一个数据源（支持嵌套 zip）
        const wbs: WorkbookData[] = await readWorkbooks(f);
        let fromThis = 0;
        for (const wb of wbs) {
          const usable = wb.sheets.filter((s) => s.rows.length >= 2);
          if (!usable.length) continue;
          fromThis++;
          parsed.push({
            fileName: wb.fileName,
            analyses: usable.map((s) => analyzeSheet(s, wb.fileName)),
          });
        }
        if (!fromThis) errs.push(`${f.name}：未读取到有效数据`);
        else if (wbs.length > 1) {
          infos.push(`${f.name}：压缩包内展开出 ${wbs.length} 个表格文件，可逐个切换预览`);
        }
      } catch (err) {
        errs.push(`${f.name} 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setErrors(errs);
    setNotes(infos);
    if (parsed.length) {
      setSources(parsed);
      setFileIdx(0);
      setSheetIdx(0);
      setOverrides({});
    }
  };

  const parsePasted = (text: string) => {
    if (!text.trim()) return;
    try {
      const wb = readWorkbookFromText(text);
      const usable = wb.sheets.filter((s) => s.rows.length >= 2);
      if (!usable.length) {
        setErrors(['粘贴内容未识别到有效数据，请检查分隔符（逗号 / 制表符）']);
        return;
      }
      setErrors([]);
      setNotes([]);
      setSources([{ fileName: wb.fileName, analyses: usable.map((s) => analyzeSheet(s, wb.fileName)) }]);
      setFileIdx(0);
      setSheetIdx(0);
      setOverrides({});
    } catch (err) {
      setErrors([`解析失败：${err instanceof Error ? err.message : String(err)}`]);
    }
  };

  const doImport = () => {
    if (!analysis || axes.length === 0) return;
    const { products: created, notes: n } = buildProducts(analysis, axes, mode, products.length);
    // 提示反推出的分红 / 拆分，引导到复权面板核对
    for (const p of created) {
      const div = p.detected.filter((a) => a.type === 'dividend').length;
      const split = p.detected.filter((a) => a.type === 'split').length;
      if (div || split) {
        n.push(
          `「${p.name}」识别出 ${div} 次分红${split ? `、${split} 次拆分` : ''}`
          + `，可在下方「复权净值计算」中核对，逐条确认后指标按复权净值重算`,
        );
      }
    }
    setNotes(n);
    if (created.length) onAdd(created);
    else if (!n.length) setErrors(['所选列没有有效数据（需至少 2 行可解析的日期 + 数值）']);
  };

  const clearParsed = () => {
    setSources([]);
    setErrors([]);
    setNotes([]);
    setOverrides({});
  };

  const toggleAxis = (i: number) => {
    setAxes((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort((a, b) => a - b)));
  };

  const orientation: Orientation = analysis?.orientation ?? 'vertical';
  const axisLabel = orientation === 'vertical' ? '列' : '行';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Table2 className="h-5 w-5" /> 数据导入
        </CardTitle>
        <CardDescription>
          支持 <b>Excel（.xlsx / .xls）</b>、CSV / TXT、<b>ZIP 压缩包</b>与直接粘贴。自动识别多工作表、表头行、日期列与数值列；
          <b>一张宽表里的每一列可直接作为一个产品</b>，用于后续多产品对比。
          同时选中「单位净值 + 累计净值」两列时会自动合并为一个产品，并据此反推分红与拆分、计算复权净值。
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ---------- 文件选择 ---------- */}
        <div
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            dragging ? 'border-primary bg-accent/40' : 'border-muted-foreground/25'
          }`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.length) loadFiles(e.dataTransfer.files);
          }}
        >
          <FileSpreadsheet className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm text-muted-foreground">
            把 Excel / CSV / <b>ZIP 压缩包</b>拖到这里，或
          </p>
          <p className="text-xs text-muted-foreground">
            压缩包会自动展开（含嵌套 zip），包内每个表格各成一个数据源，并自动读取其中的基金产品名称
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              <FileUp className="mr-2 h-4 w-4" /> 选择文件（可多选）
            </Button>
            <Button size="sm" variant="outline" onClick={onLoadSample}>
              <Sparkles className="mr-2 h-4 w-4" /> 载入示例数据
            </Button>
          </div>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".csv,.txt,.xlsx,.xls,.xlsm,.zip"
            className="hidden"
            onChange={(e) => e.target.files?.length && loadFiles(e.target.files)}
          />
        </div>

        {/* ---------- 粘贴 ---------- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">
              粘贴净值数据（三列：日期 / 单位净值 / 累计净值；或宽表：日期 + 多产品列）
            </Label>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
                onClick={() => { setPaste(SAMPLE_TEXT); parsePasted(SAMPLE_TEXT); }}>
                单产品示例
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs"
                onClick={() => { setPaste(SAMPLE_WIDE); parsePasted(SAMPLE_WIDE); }}>
                多产品示例
              </Button>
            </div>
          </div>
          <Textarea
            rows={4}
            placeholder={`日期,单位净值,累计净值\n2024-01-02,1.0120,1.0520\n...`}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <Button size="sm" variant="secondary" onClick={() => parsePasted(paste)} disabled={!paste.trim()}>
            <ClipboardPaste className="mr-2 h-4 w-4" /> 解析粘贴内容
          </Button>
        </div>

        {/* ---------- 解析预览 ---------- */}
        {sources.length > 0 && analysis && (
          <>
            <Separator />
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="gap-1">
                  <FileSpreadsheet className="h-3 w-3" /> 解析预览
                </Badge>
                <span
                  className="max-w-md truncate text-sm text-muted-foreground"
                  title={sources[fileIdx].fileName}
                >
                  {sources[fileIdx].fileName}
                </span>
                {nameInfo && (
                  <Badge variant="outline" className="gap-1 border-emerald-300 bg-emerald-50 text-emerald-800">
                    <Sparkles className="h-3 w-3" />
                    识别产品：<b className="font-semibold">{nameInfo.short}</b>
                    {nameInfo.code && <span className="font-mono text-[11px]">{nameInfo.code}</span>}
                  </Badge>
                )}
                <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={clearParsed}>
                  <X className="mr-1 h-3 w-3" /> 清除
                </Button>
              </div>

              {/* 工作表切换 */}
              {sources.length > 1 || sources[0].analyses.length > 1 ? (
                <div className="flex flex-wrap gap-1">
                  {sources.map((s, fi) =>
                    s.analyses.map((a, si) => (
                      <Button
                        key={`${fi}-${si}`}
                        size="sm"
                        variant={fi === fileIdx && si === sheetIdx ? 'default' : 'outline'}
                        className="h-7 max-w-56 text-xs"
                        title={sources.length > 1 ? `${s.fileName} / ${a.sheetName}` : a.sheetName}
                        onClick={() => { setFileIdx(fi); setSheetIdx(si); setOverrides({}); }}
                      >
                        <span className="block truncate">
                          {sources.length > 1 ? `${s.fileName} / ` : ''}{a.sheetName}
                        </span>
                      </Button>
                    )),
                  )}
                </div>
              ) : null}

              {/* 版面参数 */}
              <div className="flex flex-wrap items-end gap-4 rounded-lg bg-muted/40 p-3">
                <div className="w-32">
                  <Label className="text-xs text-muted-foreground">版面</Label>
                  <Select
                    value={orientation}
                    onValueChange={(v) => setOverrides((o) => ({ ...o, orientation: v as Orientation }))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="vertical">纵向（日期在列）</SelectItem>
                      <SelectItem value="horizontal">横向（日期在行）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32">
                  <Label className="text-xs text-muted-foreground">表头{orientation === 'vertical' ? '行' : '列'}</Label>
                  <Select
                    value={String(analysis.headerIndex)}
                    onValueChange={(v) => setOverrides((o) => ({ ...o, headerIndex: Number(v) }))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: Math.min(15, analysis.rows.length) }, (_, i) => (
                        <SelectItem key={i} value={String(i)}>第 {i + 1} {orientation === 'vertical' ? '行' : '列'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-40">
                  <Label className="text-xs text-muted-foreground">日期{axisLabel}</Label>
                  <Select
                    value={String(analysis.dateIndex)}
                    onValueChange={(v) => setOverrides((o) => ({ ...o, dateIndex: Number(v) }))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {analysis.axes.map((a) => (
                        <SelectItem key={a.index} value={String(a.index)}>
                          {a.index + 1} · {a.header || '（无表头）'}
                          {a.dateRatio > 0.5 ? ` · ${(a.dateRatio * 100).toFixed(0)}% 日期` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-36">
                  <Label className="text-xs text-muted-foreground">导入方式</Label>
                  <Select value={mode} onValueChange={(v) => setMode(v as ImportMode)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自动识别</SelectItem>
                      <SelectItem value="perColumn">每{axisLabel}一个产品</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="text-xs text-muted-foreground">
                  识别 {analysis.dataCount} 行数据 · {valueAxes.length} 个数值{axisLabel}
                  {analysis.confidence > 0 && ` · 日期匹配 ${(analysis.confidence * 100).toFixed(0)}%`}
                </div>
              </div>

              {/* 数值轴选择 */}
              {valueAxes.length === 0 ? (
                <Alert variant="destructive">
                  <AlertDescription className="text-xs">
                    未识别到数值{axisLabel}。请尝试调整上方的「表头行」或「日期{axisLabel}」。
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10" />
                        <TableHead>序列名称</TableHead>
                        <TableHead className="w-24">类型</TableHead>
                        <TableHead className="w-32">有效样本</TableHead>
                        <TableHead>样本值</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {valueAxes.map((a) => (
                        <TableRow key={a.index}>
                          <TableCell>
                            <Checkbox
                              checked={axes.includes(a.index)}
                              onCheckedChange={() => toggleAxis(a.index)}
                            />
                          </TableCell>
                          <TableCell className="font-medium">{a.header || `第${a.index + 1}${axisLabel}`}</TableCell>
                          <TableCell>
                            <Badge variant={a.looksLikeReturn ? 'secondary' : 'outline'} className="text-xs">
                              {a.looksLikeReturn ? '收益率' : '净值'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground tabular-nums">
                            {a.validCount} 个
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground tabular-nums">
                            {a.samples.slice(0, 3).join(' / ')}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={doImport} disabled={axes.length === 0}>
                  <Upload className="mr-2 h-4 w-4" />
                  导入选中 {axes.length} {axisLabel}
                </Button>
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setAxes(valueAxes.map((a) => a.index))}
                >
                  全选
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAxes([])}>清空</Button>
              </div>
            </div>
          </>
        )}

        {/* ---------- 提示 ---------- */}
        {(errors.length > 0 || notes.length > 0) && (
          <Alert variant={errors.length ? 'destructive' : 'default'}>
            <AlertDescription>
              <div className="space-y-0.5 text-xs">
                {errors.slice(0, 5).map((e, i) => <div key={`e${i}`}>{e}</div>)}
                {notes.slice(0, 5).map((n, i) => <div key={`n${i}`}>{n}</div>)}
              </div>
            </AlertDescription>
          </Alert>
        )}

        {/* ---------- 全局参数 ---------- */}
        <Separator />
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-40">
            <Label htmlFor="rf" className="text-xs text-muted-foreground">无风险利率（年化 %）</Label>
            <Input
              id="rf" value={rf} type="number" step="0.1" min="0" max="20"
              onChange={(e) => onRfChange(Number(e.target.value) || 0)}
            />
          </div>
          <div className="w-56">
            <Label className="text-xs text-muted-foreground">年化口径</Label>
            <Select value={annualMode} onValueChange={(v) => onAnnualModeChange(v as AnnualMode)}>
              <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="calendar">自然日 365 天（几何年化）</SelectItem>
                <SelectItem value="trading">交易日 252 天（ARGOS 口径）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            修改后全部指标与对比结果实时重算。收益率基于累计净值计算（等价分红再投资）；
            波动率 / 夏普 / 索提诺按交易日 √252 年化。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
