import { build } from 'esbuild'
import { readdir, readFile, writeFile } from 'node:fs/promises'

const bundles = await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, metafile: true, platform: 'node', target: 'node20', external: ['vscode'], outfile: 'dist/extension.cjs' }),
  build({ entryPoints: ['src/webview.ts'], bundle: true, metafile: true, platform: 'browser', target: 'es2022', outfile: 'dist/webview.js' }),
])
const packages = [...new Set(bundles.flatMap(({ metafile }) => Object.keys(metafile.inputs).flatMap(input => {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)
  return match ? [match[1]] : []
})))].sort()
const notices = []
for (const directory of packages) {
  const { name, version, license } = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'))
  notices.push(`## ${name} ${version} (${license})`)
  const files = (await readdir(directory)).filter(name => /^(license|notice|copying)/i.test(name))
  if (!files.length) throw new Error(`Missing license text for ${name}`)
  for (const file of files) notices.push(await readFile(`${directory}/${file}`, 'utf8'))
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n'))
