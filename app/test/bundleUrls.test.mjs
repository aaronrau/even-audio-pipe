import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const distDir = new URL('../dist', import.meta.url)
const manifestPath = new URL('../app.example.json', import.meta.url)
const urlPattern = /(?:https?|wss?):\/\/[^\s"'`<>),;]+/g

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const whitelist = new Set(
  manifest.permissions
    ?.find(permission => permission?.name === 'network')
    ?.whitelist ?? [],
)

const bundleUrls = new Set()
for (const path of filesIn(distDir.pathname)) {
  const text = readFileSync(path, 'utf8')
  for (const match of text.matchAll(urlPattern)) bundleUrls.add(match[0])
}

const unlistedUrls = [...bundleUrls].filter(url => !whitelist.has(url))

assert.deepEqual(
  unlistedUrls,
  [],
  `bundle URL(s) not listed in app.example.json network.whitelist: ${unlistedUrls.join(', ')}`,
)

console.log('bundle URL whitelist test passed')

function filesIn(dir) {
  const paths = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      paths.push(...filesIn(path))
    } else {
      paths.push(path)
    }
  }
  return paths
}
