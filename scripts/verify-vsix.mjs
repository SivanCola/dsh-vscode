import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const archive = process.argv[2] ?? `artifacts/${manifest.name}-${manifest.version}.vsix`
const unzip = (...args) => execFileSync('unzip', args, { encoding: 'utf8' })
unzip('-tq', archive)
const entries = unzip('-Z1', archive).trimEnd().split('\n')
const packaged = JSON.parse(unzip('-p', archive, 'extension/package.json'))

for (const key of ['name', 'displayName', 'publisher', 'version', 'license', 'main', 'icon']) {
  assert.equal(packaged[key], manifest[key], `Packaged manifest differs at ${key}`)
}

const required = [
  packaged.main.replace(/^\.\//, ''),
  packaged.icon,
  ...packaged.contributes.viewsContainers.activitybar.map(view => view.icon),
  'dist/webview.js',
  'dist/THIRD_PARTY_NOTICES.txt',
  'media/chat.css',
  'package.nls.json',
  'package.nls.zh-cn.json',
]
for (const file of required) {
  assert(entries.includes(`extension/${file}`), `Missing file: ${file}`)
}
assert(entries.includes('extension/LICENSE.txt') || entries.includes('extension/LICENSE'), 'Missing license')
assert(!entries.some(entry => /^extension\/(src|test|node_modules|\.github)\//.test(entry)), 'Development files in VSIX')
console.log(`Verified ${archive}`)
