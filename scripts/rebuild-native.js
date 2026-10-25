/**
 * Rebuild native modules for Electron only when no usable prebuilt binary exists.
 *
 * better-sqlite3 (>=13) and uiohook-napi ship N-API prebuilds that load in any Electron
 * version, so forcing a source build only adds a Visual Studio / Xcode / gcc requirement
 * (and fails on machines without one). Modules without a prebuild for the target
 * platform/arch are still rebuilt with @electron/rebuild.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const NODE_MODULES = path.join(ROOT_DIR, 'node_modules');
const TARGET_PLATFORM = process.env.NOTTO_TARGET_PLATFORM || process.platform;
const TARGET_ARCH = process.env.NOTTO_TARGET_ARCH || process.env.npm_config_arch || process.arch;
const FORCE_SOURCE_BUILD = process.env.NOTTO_BUILD_NATIVE_FROM_SOURCE === '1';

const PREBUILD_CHECKS = {
    'better-sqlite3': () => [path.join('prebuilds', `${TARGET_PLATFORM}-${TARGET_ARCH}.node`)],
    'uiohook-napi': () => [path.join('prebuilds', `${TARGET_PLATFORM}-${TARGET_ARCH}`, 'uiohook-napi.node')],
};

function hasPrebuild(name) {
    const candidates = PREBUILD_CHECKS[name]();
    return candidates.some((relPath) => fs.existsSync(path.join(NODE_MODULES, name, relPath)));
}

function main() {
    const installed = Object.keys(PREBUILD_CHECKS).filter((name) => fs.existsSync(path.join(NODE_MODULES, name)));
    const needsBuild = FORCE_SOURCE_BUILD ? installed : installed.filter((name) => !hasPrebuild(name));

    for (const name of installed) {
        if (!needsBuild.includes(name)) {
            console.log(`✅ ${name}: using prebuilt N-API binary for ${TARGET_PLATFORM}-${TARGET_ARCH}`);
        }
    }

    if (needsBuild.length === 0) {
        console.log('No native modules need rebuilding.');
        return;
    }

    console.log(`🔧 Rebuilding for Electron: ${needsBuild.join(', ')}`);
    const cli = path.join(NODE_MODULES, '@electron', 'rebuild', 'lib', 'cli.js');
    const result = spawnSync(process.execPath, [cli, '-f', '--arch', TARGET_ARCH, '--only', needsBuild.join(',')], {
        cwd: ROOT_DIR,
        stdio: 'inherit',
    });
    process.exit(result.status ?? 1);
}

main();
