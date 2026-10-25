const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { unusedOptionalRequiresPlugin } = require('./scripts/esbuild-plugins');
// Plugin to mark .node files and native bindings as external
const nativeModulePlugin = {
  name: 'native-module-external',
  setup(build) {
    // Mark all .node files as external (including full paths)
    build.onResolve({ filter: /\.node$/ }, (args) => {
      return { path: args.path, external: true };
    });

    // Mark paths containing /bin/ or /build/ with .node files as external
    build.onResolve({ filter: /.*\/bin\/.*\.node$/ }, (args) => {
      return { path: args.path, external: true };
    });

    build.onResolve({ filter: /.*\/build\/.*\.node$/ }, (args) => {
      return { path: args.path, external: true };
    });
  },
};

const isProduction = process.env.NODE_ENV === 'production';
const isDev = !isProduction;
const obsoleteOutputFiles = ['meeting-hud.js'];

function detectElectronNodeTarget() {
  try {
    // Requiring Electron can download its binary. Bundling must also work offline.
    const electronRoot = path.dirname(require.resolve('electron/package.json'));
    const pathFile = path.join(electronRoot, 'path.txt');
    const executableName = fs.existsSync(pathFile)
      ? fs.readFileSync(pathFile, 'utf8').trim()
      : (process.platform === 'win32' ? 'electron.exe' : 'electron');
    const electronPath = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronRoot, 'dist'), executableName);
    if (!fs.existsSync(electronPath)) throw new Error('Electron binary is not installed');
    const nodeVersion = execFileSync(
      electronPath,
      ['-e', 'console.log(process.versions.node)'],
      {
        cwd: __dirname,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8'
      }
    ).trim();

    const major = String(nodeVersion).split('.')[0];
    if (major) return `node${major}`;
  } catch (error) {
    console.warn('Falling back to minimum supported Node target:', error.message);
  }

  return 'node22.13';
}

const electronNodeTarget = detectElectronNodeTarget();

// Entry points for bundling
const entryPoints = {
  main: 'src/main.ts',
  preload: 'src/preload.ts',
  renderer: 'src/renderer.ts',
  chat: 'src/chat.ts',
  'notes-float': 'src/notes-float.ts',
  hud: 'src/hud.ts',
  permissions: 'src/permissions.ts',
};

const rendererEntries = {
  renderer: entryPoints.renderer,
  chat: entryPoints.chat,
  'notes-float': entryPoints['notes-float'],
  hud: entryPoints.hud,
  permissions: entryPoints.permissions,
};

// Native modules that should be external (not bundled)
const nativeExternals = [
  'uiohook-napi',
  'win32-api',
  'koffi',
  'electron',
  'better-sqlite3',
  'pdfjs-dist',
];

function createEnvDefines() {
  return {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  };
}

// Common build options
function createBaseOptions() {
  return {
    bundle: true,
    minify: isProduction,
    sourcemap: isDev ? 'inline' : false,
    target: electronNodeTarget,
    platform: 'node',
    format: 'cjs',
    external: [
      ...nativeExternals,
    ],
    plugins: [nativeModulePlugin, unusedOptionalRequiresPlugin],
    define: createEnvDefines(),
  };
}

function createMainOptions(outdir) {
  const baseOptions = createBaseOptions();
  return {
    ...baseOptions,
    entryPoints: { main: entryPoints.main },
    outdir,
    platform: 'node',
    format: 'cjs',
    external: [
      ...baseOptions.external,
      'electron',
    ],
    plugins: [...(baseOptions.plugins || [])],
  };
}

function createPreloadOptions(outdir) {
  const baseOptions = createBaseOptions();
  return {
    ...baseOptions,
    entryPoints: { preload: entryPoints.preload },
    outdir,
    platform: 'node',
    format: 'cjs',
  };
}

function createRendererOptions(outdir, entryPointsOverride = rendererEntries) {
  return {
    bundle: true,
    minify: isProduction,
    sourcemap: isDev ? 'inline' : false,
    target: 'es2020',
    platform: 'browser',
    format: 'iife',
    entryPoints: entryPointsOverride,
    outdir,
    define: createEnvDefines(),
    external: ['electron'],
  };
}

// Build function
async function build(options = {}) {
  const outdir = options.outdir || 'dist';
  const requestedEntries = Array.isArray(options.only) && options.only.length > 0
    ? Object.fromEntries(Object.entries(rendererEntries).filter(([name]) => options.only.includes(name)))
    : rendererEntries;

  console.log(`Building in ${isProduction ? 'production' : 'development'} mode...`);

  // Ensure dist directory exists
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  for (const file of obsoleteOutputFiles) {
    const obsoletePath = path.join(outdir, file);
    if (fs.existsSync(obsoletePath)) {
      fs.unlinkSync(obsoletePath);
    }
  }

  try {
    // Build main process
    console.log('Building main process...');
    await esbuild.build(createMainOptions(outdir));

    // Build preload
    console.log('Building preload...');
    await esbuild.build(createPreloadOptions(outdir));

    // Build renderer processes
    console.log('Building renderer processes...');
    await esbuild.build(createRendererOptions(outdir, requestedEntries));

    console.log('Build completed successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

// Watch mode
async function watch() {
  console.log('Starting watch mode...');

  const contexts = [];
  const outdir = 'dist';

  for (const file of obsoleteOutputFiles) {
    const obsoletePath = path.join(outdir, file);
    if (fs.existsSync(obsoletePath)) {
      fs.unlinkSync(obsoletePath);
    }
  }

  // Watch main process
  const mainContext = await esbuild.context(createMainOptions(outdir));
  contexts.push(mainContext);

  // Watch preload
  const preloadContext = await esbuild.context(createPreloadOptions(outdir));
  contexts.push(preloadContext);

  // Watch renderer processes
  const rendererContext = await esbuild.context(createRendererOptions(outdir));
  contexts.push(rendererContext);

  // Start watching all contexts
  await Promise.all(contexts.map(ctx => ctx.watch()));

  console.log('Watching for changes...');
}

// Run build or watch
if (require.main === module) {
  const command = process.argv[2];
  if (command === 'watch') {
    watch().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  } else {
    build().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  }
}

module.exports = { build, watch, entryPoints };
