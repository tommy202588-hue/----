import { spawnSync } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const iconSource = path.join(projectRoot, 'build', 'icon-source.png');
const iconSetDirectory = path.join(projectRoot, 'build', 'icon.iconset');
const iconOutput = path.join(projectRoot, 'build', 'icon.icns');

const fileExists = async filePath => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
};

if (await fileExists(iconOutput)) {
  process.exit(0);
}

if (process.platform !== 'darwin') {
  console.warn('build/icon.icns is generated on macOS with sips and iconutil.');
  process.exit(0);
}

if (!(await fileExists(iconSource))) {
  throw new Error(`Missing icon source: ${iconSource}`);
}

await rm(iconSetDirectory, { recursive: true, force: true });
await mkdir(iconSetDirectory, { recursive: true });

const sizes = [16, 32, 64, 128, 256, 512];
for (const size of sizes) {
  run('sips', ['-z', String(size), String(size), iconSource, '--out', path.join(iconSetDirectory, `icon_${size}x${size}.png`)]);
  run('sips', ['-z', String(size * 2), String(size * 2), iconSource, '--out', path.join(iconSetDirectory, `icon_${size}x${size}@2x.png`)]);
}

run('iconutil', ['-c', 'icns', iconSetDirectory, '-o', iconOutput]);
await rm(iconSetDirectory, { recursive: true, force: true });
