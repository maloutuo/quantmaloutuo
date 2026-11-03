/**
 * 打包交付物：
 *  1) 生成单文件 HTML（CSS / JS 全部内联，双击即开，无需服务器）
 *  2) 生成 zip（含单文件 HTML、dist 目录与源码）
 * 运行：node scripts/package.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const dist = resolve(root, 'dist');
const outDir = resolve(root, 'release');

const readDirFiles = (dir) => readdirSync(resolve(root, dir));

const jsFile = 'dist/assets/' + readDirFiles('dist/assets').find((f) => f.endsWith('.js'));
const cssFile = 'dist/assets/' + readDirFiles('dist/assets').find((f) => f.endsWith('.css'));

const js = readFileSync(resolve(root, jsFile), 'utf8');
const css = readFileSync(resolve(root, cssFile), 'utf8');

if (/<\/script/i.test(js)) throw new Error('JS 中包含 </script，无法安全内联');

const single = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>绩效分析平台</title>
    <style>${css}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">${js}</script>
  </body>
</html>
`;

if (existsSync(outDir)) rmSync(outDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const htmlPath = resolve(outDir, '绩效分析平台.html');
writeFileSync(htmlPath, single, 'utf8');
console.log('单文件 HTML：', htmlPath, (single.length / 1024 / 1024).toFixed(2), 'MB');

// 同步一份 dist 便于 zip 内保留目录结构
const distCopy = resolve(outDir, 'dist');
mkdirSync(distCopy, { recursive: true });
writeFileSync(resolve(distCopy, 'index.html'), readFileSync(resolve(dist, 'index.html'), 'utf8'), 'utf8');
mkdirSync(resolve(distCopy, 'assets'), { recursive: true });
for (const f of readDirFiles('dist/assets')) {
  copyFileSync(resolve(dist, 'assets', f), resolve(distCopy, 'assets', f));
}

const zip = resolve(root, '绩效分析平台.zip');
if (existsSync(zip)) rmSync(zip);

// 用 PowerShell Compress-Archive 打包（Windows 环境可靠）
const rel = (p) => `'${resolve(root, p)}'`;
const ps = [
  `$ErrorActionPreference='Stop'`,
  `Remove-Item ${rel('绩效分析平台.zip')} -ErrorAction SilentlyContinue`,
  `Compress-Archive -Path ${rel('release/绩效分析平台.html')},${rel('release/dist')},${rel('src')},${rel('package.json')},${rel('README.md')} -DestinationPath ${rel('绩效分析平台.zip')} -CompressionLevel Optimal`,
].join('; ');

try {
  execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
  console.log('打包完成：', zip);
} catch (err) {
  console.error('打包失败：', err.message);
  process.exit(1);
}

console.log('包含内容：单文件 HTML / dist / src / package.json / README.md');
