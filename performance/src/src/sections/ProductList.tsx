import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Layers, Trash2, Flag } from 'lucide-react';
import type { Product } from '@/types';

interface Props {
  products: Product[];
  activeId: string;
  onActivate: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Product>) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

export function ProductList({ products, activeId, onActivate, onUpdate, onRemove, onClearAll }: Props) {
  if (products.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="h-5 w-5" /> 产品列表
          <Badge variant="outline" className="ml-1 font-normal">{products.length} 条</Badge>
        </CardTitle>
        <CardDescription>
          点击行可切换「单产品分析」的对象；勾选决定参与多产品对比的序列；
          设为基准的序列不参与排名，仅作为对比参照。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">对比</TableHead>
                <TableHead className="w-8" />
                <TableHead>产品名称</TableHead>
                <TableHead className="w-32">数据来源</TableHead>
                <TableHead className="w-40">区间</TableHead>
                <TableHead className="w-16 text-right">样本</TableHead>
                <TableHead className="w-24 text-center">基准</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => {
                const first = p.points[0]?.date ?? '—';
                const last = p.points[p.points.length - 1]?.date ?? '—';
                const isActive = p.id === activeId;
                return (
                  <TableRow
                    key={p.id}
                    className={`cursor-pointer ${isActive ? 'bg-accent/50' : ''}`}
                    onClick={() => onActivate(p.id)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={p.visible}
                        onCheckedChange={(c) => onUpdate(p.id, { visible: !!c })}
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: p.color }}
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Input
                              value={p.name}
                              className="h-7 max-w-56 text-sm"
                              onChange={(e) => onUpdate(p.id, { name: e.target.value })}
                            />
                            {isActive && <Badge variant="secondary" className="text-xs">当前</Badge>}
                          </div>
                          {(p.fullName || p.code) && (
                            <div
                              className="mt-0.5 max-w-56 truncate text-[11px] text-muted-foreground"
                              title={[p.fullName, p.code].filter(Boolean).join(' · ')}
                            >
                              {p.code && <span className="mr-1 font-mono">{p.code}</span>}
                              {p.fullName}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate" title={p.source}>
                      {p.source}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {first} ~ {last}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {p.points.length}
                    </TableCell>
                    <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant={p.isBenchmark ? 'default' : 'ghost'}
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => onUpdate(p.id, { isBenchmark: !p.isBenchmark })}
                      >
                        <Flag className="mr-1 h-3 w-3" />
                        {p.isBenchmark ? '基准' : '设为'}
                      </Button>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground"
                        onClick={() => onRemove(p.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onClearAll}>
            <Trash2 className="mr-2 h-3.5 w-3.5" /> 清空全部
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
