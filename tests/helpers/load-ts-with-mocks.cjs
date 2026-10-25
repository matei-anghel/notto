const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')

function loadTsWithMocks(filename, mocks = {}) {
  const absolute = path.resolve(filename)
  const compiled = esbuild.transformSync(fs.readFileSync(absolute, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node22', supported: { 'dynamic-import': false }
  })
  const mod = new Module(absolute, module)
  mod.filename = absolute
  mod.paths = Module._nodeModulePaths(path.dirname(absolute))
  mod.require = request => Object.hasOwn(mocks, request)
    ? mocks[request]
    : Module.prototype.require.call(mod, request)
  mod._compile(compiled.code, absolute)
  return mod.exports
}

module.exports = { loadTsWithMocks }
