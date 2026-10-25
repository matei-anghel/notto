/**
 * Copy native Node.js modules to the dist folder for Electron packaging
 * This ensures native modules like better-sqlite3 and uiohook-napi work correctly
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const NODE_MODULES = path.join(ROOT_DIR, 'node_modules');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const RESOURCES_BIN_DIR = path.join(ROOT_DIR, 'resources', 'bin');
const TARGET_PLATFORM = process.env.NOTTO_TARGET_PLATFORM || process.platform;
const TARGET_ARCH = process.env.NOTTO_TARGET_ARCH || process.arch;

const MODULE_COPY_PLANS = [
    {
        name: 'better-sqlite3',
        paths: ['package.json', 'LICENSE', 'lib', path.join('prebuilds', `${TARGET_PLATFORM}-${TARGET_ARCH}.node`), path.join('build', 'Release', 'better_sqlite3.node')]
    },
    {
        name: 'uiohook-napi',
        paths: ['package.json', 'LICENSE', 'dist', path.join('build', 'Release', 'uiohook_napi.node'), path.join('prebuilds', `${TARGET_PLATFORM}-${TARGET_ARCH}`)]
    },
    ...(TARGET_PLATFORM === 'win32'
        ? [{ name: 'win32-api', paths: ['package.json', 'LICENSE', 'dist'] }]
        : [])
];
const PRUNE_DIRS = new Set([
    'test',
    'tests',
    'example',
    'examples',
    'docs',
    'doc',
    'benchmark',
    'benchmarks',
    '.github'
]);

function copyFolderRecursive(src, dest) {
    if (!fs.existsSync(src)) {
        return false;
    }

    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory() && PRUNE_DIRS.has(entry.name)) {
            continue;
        }

        if (entry.isFile() && /\.(md|markdown|map)$/i.test(entry.name)) {
            continue;
        }

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyFolderRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
    return true;
}

function copyEntry(srcPath, destPath) {
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) {
        copyFolderRecursive(srcPath, destPath);
        return;
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
}

function copyNativeModule(plan) {
    const srcPath = path.join(NODE_MODULES, plan.name);
    const destPath = path.join(DIST_DIR, 'node_modules', plan.name);

    if (!fs.existsSync(srcPath)) {
        console.log(`⚠️  Skipping ${plan.name} (not installed)`);
        return;
    }

    try {
        if (fs.existsSync(destPath)) {
            fs.rmSync(destPath, { recursive: true, force: true });
        }

        for (const relPath of plan.paths) {
            const srcEntry = path.join(srcPath, relPath);
            if (!fs.existsSync(srcEntry)) {
                console.log(`⚠️  Skipping missing ${plan.name}/${relPath}`);
                continue;
            }
            copyEntry(srcEntry, path.join(destPath, relPath));
        }

        console.log(`✅ Copied runtime files for: ${plan.name}`);
    } catch (error) {
        console.error(`❌ Failed to copy ${plan.name}:`, error.message);
        process.exit(1);
    }
}

function verifyHelperContract() {
    if (!fs.existsSync(RESOURCES_BIN_DIR)) {
        console.log('INFO: resources/bin not found; helper binaries must be built before packaging.');
        return;
    }

    const archDirs = fs.readdirSync(RESOURCES_BIN_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

    if (archDirs.length === 0) {
        console.log('INFO: resources/bin exists but no platform-arch helper folders were found.');
        return;
    }

        console.log(`INFO: Helper binaries will be packaged from resources/bin/${archDirs.join(', resources/bin/')}.`);
}

function main() {
    console.log('📦 Copying native modules to dist/...\n');

    if (!fs.existsSync(DIST_DIR)) {
        console.error('❌ dist/ directory not found. Run `npm run build:prod` first.');
        process.exit(1);
    }

    // Create node_modules folder in dist if it doesn't exist
    const distNodeModules = path.join(DIST_DIR, 'node_modules');
    fs.mkdirSync(distNodeModules, { recursive: true });

    for (const plan of MODULE_COPY_PLANS) {
        copyNativeModule(plan);
    }

    verifyHelperContract();

    console.log('\n✨ Native modules copied successfully!');
}

main();
