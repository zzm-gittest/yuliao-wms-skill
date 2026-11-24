#!/usr/bin/env node
/**
 * yuliao-wms-skill installer patch.
 *
 * Idempotently registers the two plugin packages into a dsh
 * (deepseek-harness) checkout:
 *   1. packages/bundle/web-app/cordis.patch.yml  — wms-ai roster entry
 *   2. packages/bundle/web-app/package.json      — workspace dependencies
 *
 * Both files are backed up as *.yuliao-bak before the first modification.
 * Re-running is safe: existing registrations are detected and skipped.
 *
 * Usage: node apply-wms-patch.mjs <dsh-repo-path>
 */
import fs from 'node:fs'
import path from 'node:path'

const dsh = path.resolve(process.argv[2] ?? '.')
const patchYml = path.join(dsh, 'packages/bundle/web-app/cordis.patch.yml')
const appPkg = path.join(dsh, 'packages/bundle/web-app/package.json')

for (const file of [patchYml, appPkg]) {
  if (!fs.existsSync(file)) {
    console.error(`[patch] FAIL: not found: ${file}`)
    console.error('[patch] Is the target really a deepseek-harness checkout?')
    process.exit(1)
  }
}

let changed = 0

// ---- 1. cordis.patch.yml: wms-ai roster entry --------------------------------
const WMS_BLOCK = [
  '',
  '    # yuliao-wms-skill: WMS/ERP assistant plugin. The node half is loaded',
  '    # here (sign-in + API proxy routes); the browser half auto-loads via the',
  '    # dsh.client declaration scan.',
  '    - id: wms-ai',
  "      name: '@deepseek-ai/dsh-wms-ai'",
  '      config:',
  "        defaultBaseUrl: !!js process.env.WMS_BASE_URL ?? 'http://127.0.0.1:8080'",
  '        loginPath: /systemLogin',
  '        timeoutMs: 30000',
  '',
].join('\n')

{
  let yml = fs.readFileSync(patchYml, 'utf8')
  if (yml.includes('- id: wms-ai')) {
    console.log('[patch] cordis.patch.yml already registers wms-ai — skip')
  } else {
    const anchor = '    - id: workspace-changes'
    if (yml.includes(anchor)) {
      yml = yml.replace(anchor, WMS_BLOCK + '\n' + anchor)
    } else {
      // Anchor drifted upstream: append before the final preset-registry
      // section marker, which is the last `- insert:` in the file.
      const fallback = yml.lastIndexOf('- insert:')
      if (fallback === -1) {
        console.error('[patch] FAIL: no insertion anchor found in cordis.patch.yml.')
        console.error('[patch] Add the wms-ai entry manually (see README.md §Manual patch).')
        process.exit(1)
      }
      yml = yml.slice(0, fallback) + WMS_BLOCK.trimStart() + '\n\n' + yml.slice(fallback)
    }
    fs.writeFileSync(patchYml + '.yuliao-bak', fs.readFileSync(patchYml))
    fs.writeFileSync(patchYml, yml)
    changed++
    console.log('[patch] cordis.patch.yml: wms-ai roster entry added (backup: .yuliao-bak)')
  }
}

// ---- 2. web-app package.json: workspace dependencies -------------------------
{
  let pkg = fs.readFileSync(appPkg, 'utf8')
  if (pkg.includes('"@deepseek-ai/dsh-wms-ai"')) {
    console.log('[patch] package.json already declares wms-ai deps — skip')
  } else {
    const anchor = '    "@deepseek-ai/dsh-web-frontend": "workspace:*",'
    const deps = [
      '    "@deepseek-ai/dsh-wms-ai": "workspace:*",',
      '    "@deepseek-ai/dsh-wms-llm-bridge": "workspace:*",',
    ].join('\n')
    if (pkg.includes(anchor)) {
      pkg = pkg.replace(anchor, anchor + '\n' + deps)
      fs.writeFileSync(appPkg + '.yuliao-bak', fs.readFileSync(appPkg))
      fs.writeFileSync(appPkg, pkg)
    } else {
      // Structural fallback: JSON edit (reformats the file).
      const json = JSON.parse(pkg)
      json.dependencies ??= {}
      json.dependencies['@deepseek-ai/dsh-wms-ai'] = 'workspace:*'
      json.dependencies['@deepseek-ai/dsh-wms-llm-bridge'] = 'workspace:*'
      fs.writeFileSync(appPkg + '.yuliao-bak', fs.readFileSync(appPkg))
      fs.writeFileSync(appPkg, JSON.stringify(json, null, 2) + '\n')
    }
    changed++
    console.log('[patch] package.json: workspace deps added (backup: .yuliao-bak)')
  }
}

console.log(`[patch] done, ${changed} file(s) modified.`)
