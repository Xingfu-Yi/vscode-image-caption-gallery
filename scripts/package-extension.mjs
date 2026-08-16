import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const temporaryDirectory = path.join(projectRoot, '.marketplace');
const marketplaceReadme = path.join(temporaryDirectory, 'README.md');

const imageReplacements = new Map([
  [
    'docs/images/gallery-overview.jpg',
    'https://gitee.com/outer_space/web-image/raw/master/vscode/Image-Caption-Gallery/01.jpg',
  ],
  [
    'docs/images/gallery-detail-zh.jpg',
    'https://gitee.com/outer_space/web-image/raw/master/vscode/Image-Caption-Gallery/02.jpg',
  ],
  [
    'docs/images/gallery-detail-en.jpg',
    'https://gitee.com/outer_space/web-image/raw/master/vscode/Image-Caption-Gallery/03.jpg',
  ],
]);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`vsce was terminated by ${signal}`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`vsce exited with code ${code}`));
      }
    });
  });
}

await rm(temporaryDirectory, { recursive: true, force: true });

try {
  let readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8');

  for (const [localPath, remoteUrl] of imageReplacements) {
    if (!readme.includes(localPath)) {
      throw new Error(`README image path not found: ${localPath}`);
    }
    readme = readme.replaceAll(localPath, remoteUrl);
  }

  await mkdir(temporaryDirectory, { recursive: true });
  await writeFile(marketplaceReadme, readme, 'utf8');

  const vsce = path.join(projectRoot, 'node_modules', '.bin', 'vsce');
  await run(vsce, [
    'package',
    '--readme-path',
    path.relative(projectRoot, marketplaceReadme),
    ...process.argv.slice(2),
  ]);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
