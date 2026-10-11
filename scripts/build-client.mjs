/** DSH 0.2.0-rc.2 lazy-CJS client contract; no Host code or second React enters this artifact. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const id = '@finneas/dsh-safe-review'
// Exact shared baseline from official packages/client/web/src/platform.ts.
const external = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']
await build({
  absWorkingDir: root, entryPoints: ['src/client/index.ts'], outfile: 'lib/client.js',
  platform: 'browser', format: 'cjs', target: ['es2022'], bundle: true, minify: true,
  external, define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
  footer: { js: 'return module.exports;}});' },
  plugins: [{ name: 'safe-review-client-boundary', setup(builder) {
    builder.onResolve({ filter: /^@deepseek-ai\// }, ({ path }) => {
      if (external.includes(path)) return { path, external: true }
      throw new Error(`Client runtime import is outside the shared baseline: ${path}`)
    })
    builder.onResolve({ filter: /^node:/ }, ({ path }) => { throw new Error(`Host import reached client bundle: ${path}`) })
  } }],
})
