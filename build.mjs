import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const isDev = process.argv.includes('--watch');

async function copyDir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

async function copyStaticAssets() {
  await fs.promises.mkdir('dist/renderer', { recursive: true });
  await fs.promises.mkdir('dist/presenter', { recursive: true });

  if (fs.existsSync('src/renderer/index.html')) {
    await fs.promises.copyFile('src/renderer/index.html', 'dist/renderer/index.html');
  }
  if (fs.existsSync('src/renderer/styles')) {
    await copyDir('src/renderer/styles', 'dist/renderer/styles');
  }
  if (fs.existsSync('src/presenter/index.html')) {
    await fs.promises.copyFile('src/presenter/index.html', 'dist/presenter/index.html');
  }
  if (fs.existsSync('src/presenter/presenter.css')) {
    await fs.promises.copyFile('src/presenter/presenter.css', 'dist/presenter/presenter.css');
  }
  if (fs.existsSync('src/converter')) {
    await copyDir('src/converter', 'dist/converter');
  }
}

async function build() {
  await copyStaticAssets();

  // 1. Main process
  await esbuild.build({
    entryPoints: ['src/main/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: 'dist/main/main.js',
    external: ['electron', 'adm-zip', 'chokidar'],
    sourcemap: true,
  });

  // 2. Preload scripts
  await esbuild.build({
    entryPoints: [
      'src/preload/preload.ts',
      'src/preload/presenter-preload.ts'
    ],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outdir: 'dist/preload',
    external: ['electron'],
    sourcemap: true,
  });

  // 3. Renderer script
  await esbuild.build({
    entryPoints: ['src/renderer/app.ts'],
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'esm',
    outfile: 'dist/renderer/app.js',
    sourcemap: true,
  });

  // 4. Presenter script
  await esbuild.build({
    entryPoints: ['src/presenter/presenter.ts'],
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'esm',
    outfile: 'dist/presenter/presenter.js',
    sourcemap: true,
  });

  console.log('Build completed successfully.');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
