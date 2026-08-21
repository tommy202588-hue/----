import { spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputRoot = path.join(projectRoot, 'local-package-dist');
const runtimeCacheRoot = path.join(outputRoot, 'node-runtime-cache');
const nodeVersion = process.versions.node;

const sourceEntries = [
  'components',
  'public',
  'services',
  'types',
  'App.tsx',
  'index.css',
  'index.html',
  'index.tsx',
  'package-lock.json',
  'package.json',
  'postcss.config.js',
  'tailwind.config.js',
  'types.ts',
  'vite.config.ts',
];

const packageVariants = [
  { suffix: 'win-x64', os: 'win32', cpu: 'x64', runtime: 'local' },
  { suffix: 'mac-arm64', os: 'darwin', cpu: 'arm64', runtime: 'download' },
  { suffix: 'mac-x64', os: 'darwin', cpu: 'x64', runtime: 'download' },
];
const variantFilter = process.argv.find(argument => argument.startsWith('--variant='))?.slice('--variant='.length);
const selectedVariants = variantFilter
  ? packageVariants.filter(variant => variant.suffix === variantFilter)
  : packageVariants;
if (variantFilter && selectedVariants.length === 0) {
  throw new Error(`Unknown package variant: ${variantFilter}`);
}

const npmCliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
};

const fileExists = async filePath => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const getCachedNodeRuntimePath = cpu => path.join(runtimeCacheRoot, `node-v${nodeVersion}-darwin-${cpu}`);

const seedNodeRuntimeCache = async (variant, existingVariantDirectory) => {
  if (variant.runtime !== 'download') return;
  const cachePath = getCachedNodeRuntimePath(variant.cpu);
  if (await fileExists(cachePath)) return;

  const existingRuntimePath = path.join(existingVariantDirectory, 'runtime', 'node');
  if (!(await fileExists(existingRuntimePath))) return;

  await mkdir(runtimeCacheRoot, { recursive: true });
  await copyFile(existingRuntimePath, cachePath);
};

const downloadNodeRuntime = async (cpu, variantDirectory) => {
  const cachePath = getCachedNodeRuntimePath(cpu);
  await mkdir(path.join(variantDirectory, 'runtime'), { recursive: true });

  if (await fileExists(cachePath)) {
    console.log(`Using cached macOS Node runtime for ${cpu}`);
    await copyFile(cachePath, path.join(variantDirectory, 'runtime', 'node'));
    return;
  }

  const archiveName = `node-v${nodeVersion}-darwin-${cpu}.tar.gz`;
  const archivePath = path.join(outputRoot, archiveName);
  const extractionDirectory = path.join(outputRoot, `node-extract-${cpu}`);
  const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
  console.log(`Downloading ${url}`);
  run('curl.exe', [
    '--fail',
    '--location',
    '--retry',
    '3',
    '--connect-timeout',
    '30',
    '--max-time',
    '300',
    '--output',
    archivePath,
    url,
  ]);
  await rm(extractionDirectory, { recursive: true, force: true });
  await mkdir(extractionDirectory, { recursive: true });
  // Extract only the executable. The archive also contains npm/npx symlinks,
  // which Windows tar cannot materialize while building a macOS package.
  run('tar.exe', [
    '-xzf',
    archivePath,
    '-C',
    extractionDirectory,
    `node-v${nodeVersion}-darwin-${cpu}/bin/node`,
  ]);
  const extractedRoot = path.join(extractionDirectory, `node-v${nodeVersion}-darwin-${cpu}`);
  await mkdir(runtimeCacheRoot, { recursive: true });
  await copyFile(path.join(extractedRoot, 'bin', 'node'), cachePath);
  await copyFile(cachePath, path.join(variantDirectory, 'runtime', 'node'));
  await rm(archivePath, { force: true });
  await rm(extractionDirectory, { recursive: true, force: true });
};

const copyProject = async variantDirectory => {
  await mkdir(variantDirectory, { recursive: true });
  for (const entry of sourceEntries) {
    await cp(path.join(projectRoot, entry), path.join(variantDirectory, entry), { recursive: true });
  }
  await copyFile(path.join(scriptDirectory, 'local-package-server.mjs'), path.join(variantDirectory, 'server.mjs'));
  await copyFile(path.join(scriptDirectory, 'start-local-package.cmd'), path.join(variantDirectory, 'start-local.cmd'));
  await copyFile(path.join(scriptDirectory, 'start-local-package.sh'), path.join(variantDirectory, 'start-local.sh'));
  await copyFile(path.join(scriptDirectory, 'start-local-package.command'), path.join(variantDirectory, 'start-local-mac.command'));
  await copyFile(path.join(scriptDirectory, 'local-package-readme.txt'), path.join(variantDirectory, 'README.txt'));

  const packageJsonPath = path.join(variantDirectory, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  delete packageJson.main;
  delete packageJson.build;
  delete packageJson.devDependencies;
  packageJson.private = true;
  packageJson.scripts = { start: 'node server.mjs' };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
};

const installDependencies = (variantDirectory, variant) => {
  const args = [npmCliPath, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', variantDirectory];
  if (variant.os !== 'win32') args.push(`--os=${variant.os}`, `--cpu=${variant.cpu}`);
  run(process.execPath, args, { cwd: variantDirectory });
};

if (!variantFilter) await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

for (const variant of selectedVariants) {
  const packageName = `X-tapnow-3004-local-${variant.suffix}`;
  const variantDirectory = path.join(outputRoot, packageName);
  const zipPath = path.join(outputRoot, `${packageName}.zip`);
  const tgzPath = path.join(outputRoot, `${packageName}.tar.gz`);
  console.log(`\nBuilding ${packageName}`);
  await seedNodeRuntimeCache(variant, variantDirectory);
  await rm(variantDirectory, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  await rm(tgzPath, { force: true });
  await copyProject(variantDirectory);
  installDependencies(variantDirectory, variant);
  if (variant.runtime === 'local') {
    await mkdir(path.join(variantDirectory, 'runtime'), { recursive: true });
    await copyFile(process.execPath, path.join(variantDirectory, 'runtime', 'node.exe'));
  } else {
    await downloadNodeRuntime(variant.cpu, variantDirectory);
  }
  run('tar.exe', ['-a', '-c', '-f', zipPath, '-C', outputRoot, packageName]);
  await tar.c({
    cwd: outputRoot,
    file: tgzPath,
    gzip: true,
    portable: true,
    onWriteEntry: entry => {
      const normalizedPath = entry.path.replaceAll('\\', '/');
      const isMacExecutable = normalizedPath.endsWith('/start-local-mac.command')
        || normalizedPath.endsWith('/start-local.sh')
        || normalizedPath.endsWith('/runtime/node');
      if (entry.type === 'Directory') entry.stat.mode = 0o755;
      else entry.stat.mode = isMacExecutable ? 0o755 : 0o644;
    },
  }, [packageName]);
  console.log(`Package directory: ${variantDirectory}`);
  console.log(`Package ZIP: ${zipPath}`);
  console.log(`Package TAR.GZ: ${tgzPath}`);
}
