const path = require('node:path')
const Module = module.constructor
const esbuild = require('esbuild')

const cache = new Map()

function loadTsModule(entryPath) {
  const absPath = path.resolve(entryPath)
  const cached = cache.get(absPath)
  if (cached) return cached.exports

  const result = esbuild.buildSync({
    entryPoints: [absPath],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    // Dependencies load from node_modules at runtime, exactly as Node would resolve them.
    packages: 'external'
  })

  const mod = new Module(absPath, module.parent)
  mod.filename = absPath
  mod.paths = Module._nodeModulePaths(path.dirname(absPath))
  mod._compile(result.outputFiles[0].text, absPath)
  cache.set(absPath, mod)
  return mod.exports
}

module.exports = { loadTsModule }
