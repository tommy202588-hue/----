import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(projectRoot, 'desktop-release-mac');
const tempConfigPath = path.join(projectRoot, 'electron-builder.mac.generated.json');

const args = new Set(process.argv.slice(2));
const archArg = process.argv.find(arg => arg.startsWith('--arch='))?.slice('--arch='.length);
const arch = archArg || (process.arch === 'arm64' ? 'arm64' : 'x64');
const supportedArchs = new Set(['arm64', 'x64']);
const label = arch === 'arm64' ? 'M系列-arm64' : 'Intel-x64';

if (!supportedArchs.has(arch)) {
  throw new Error(`Unsupported arch: ${arch}. Use --arch=arm64 or --arch=x64.`);
}

if (process.platform !== 'darwin') {
  throw new Error('macOS .app/.dmg installers must be built on macOS. Please run this script on a Mac.');
}

if (!args.has('--allow-cross-arch')) {
  const currentArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (currentArch !== arch) {
    throw new Error(`This script is building ${arch}, but the current Node.js is ${currentArch}. Run it on the matching Mac, or pass --allow-cross-arch if you know the dependencies are installed for that arch.`);
  }
}

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { cwd: projectRoot, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
};

const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const buildConfig = {
  ...packageJson.build,
  productName: '共振画布 V2.0',
  electronDist: undefined,
  directories: {
    ...(packageJson.build?.directories || {}),
    output: 'desktop-release-mac',
  },
  mac: {
    icon: 'build/icon.icns',
    category: 'public.app-category.graphics-design',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    target: [
      {
        target: 'dmg',
        arch: [arch],
      },
      {
        target: 'zip',
        arch: [arch],
      },
    ],
  },
  dmg: {
    title: '共振画布 V2.0',
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },
  win: undefined,
  nsis: undefined,
};

await rm(tempConfigPath, { force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(tempConfigPath, `${JSON.stringify(buildConfig, null, 2)}\n`, 'utf8');

try {
  run('npm', ['run', 'build']);
  run('node', ['scripts/build-desktop-config.mjs']);
  run('node', ['scripts/ensure-mac-icon.mjs']);
  run('npx', [
    'electron-builder',
    '--mac',
    `--${arch}`,
    '--config',
    tempConfigPath,
    `--config.artifactName=共振画布V2.0-mac-${label}.\${ext}`,
  ]);
  console.log('');
  console.log(`Mac installer is ready in: ${outputDirectory}`);
} finally {
  await rm(tempConfigPath, { force: true });
}
