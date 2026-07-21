import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(projectRoot, 'dist-portable');
const sourceHtmlPath = path.join(outputDirectory, 'index.html');
const portableHtmlPath = path.join(projectRoot, 'X-tapnow-便携版.html');

const resolveAssetPath = (assetUrl) => path.join(
  outputDirectory,
  assetUrl.replace(/^\.\//, '').replace(/^\//, '')
);

let html = await readFile(sourceHtmlPath, 'utf8');

const stylesheetMatches = [...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")(?=[^>]*\bhref="([^"]+)")[^>]*>/g)];
const externalStylesheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)];
if (stylesheetMatches.length !== externalStylesheets.length) {
  throw new Error('存在无法识别的外部样式标签。');
}
for (const match of stylesheetMatches) {
  const css = await readFile(resolveAssetPath(match[1]), 'utf8');
  const inlineStyle = `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  html = html.replace(match[0], () => inlineStyle);
}

const scriptMatches = [...html.matchAll(/<script\b(?=[^>]*\btype="module")(?=[^>]*\bsrc="([^"]+)")[^>]*><\/script>/g)];
const externalScripts = [...html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/g)];
if (scriptMatches.length !== externalScripts.length) {
  throw new Error('存在无法识别的外部脚本标签。');
}
for (const match of scriptMatches) {
  const javascript = await readFile(resolveAssetPath(match[1]), 'utf8');
  const inlineScript = `<script type="module">${javascript.replace(/<\/script/gi, '<\\/script')}</script>`;
  html = html.replace(match[0], () => inlineScript);
}

html = html
  .replace(/\s*<link\s+rel="icon"[^>]*>/g, '')
  .replace(/\s*<script\s+type="importmap">[\s\S]*?<\/script>/g, '')
  .replace('<html lang="en">', '<html lang="zh-CN">')
  .replace('<title>AI Creative Node Agent</title>', '<title>X-tapnow 无限画布</title>');

const outputFiles = await readdir(outputDirectory, { recursive: true });
const generatedAssets = outputFiles.filter(file => /\.(?:js|css|wasm|mjs)$/i.test(file));

await writeFile(portableHtmlPath, html, 'utf8');

const sizeInMegabytes = Buffer.byteLength(html) / 1024 / 1024;
console.log(`便携版已生成: ${portableHtmlPath}`);
console.log(`文件大小: ${sizeInMegabytes.toFixed(2)} MB`);
console.log(`已内联构建资源: ${generatedAssets.length} 个`);
