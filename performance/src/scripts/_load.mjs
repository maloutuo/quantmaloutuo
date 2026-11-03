/**
 * 测试用模块加载器：把 TS 源码（含 @/ 别名与跨文件依赖）打包成临时 ESM 再引入。
 * 产物写在 scripts/ 下，保证 xlsx 等外部依赖仍能从项目 node_modules 解析。
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { rmSync } from 'node:fs';

export async function loadModule(entry, tag = 'mod') {
  const outfile = `scripts/.tmp-${tag}.mjs`;
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    alias: { '@': './src' },
    external: ['xlsx'],
    logLevel: 'error',
  });
  const mod = await import(pathToFileURL(outfile).href);
  rmSync(outfile, { force: true });
  return mod;
}
