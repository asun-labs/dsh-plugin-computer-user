import { defineConfig } from 'tsdown'

const packageName = '@asun-labs/dsh-plugin-computer-user'

export default defineConfig([
  {
    name: packageName,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22.19.0',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
  {
    name: `${packageName}/client`,
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: true,
    sourcemap: true,
    clean: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
    noExternal: (id: string) => id.startsWith('@deepseek-ai/') ? undefined : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
