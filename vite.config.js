import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build as esbuild } from 'esbuild'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// The WASIX runtime needs SharedArrayBuffer, which browsers only enable on
// cross-origin isolated pages. Production hosts must send the same headers
// (see public/_headers, vercel.json and public/coi-serviceworker.js).
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

// The Wasmer SDK starts Web Workers that import the SDK's own modules by
// relative URL, which breaks once Vite bundles and renames them. Production
// builds therefore ship the SDK unmodified in wasmer-sdk/ and load it from
// there (see src/lib/runtime/wasmer.js). Its one dependency, the Wisp client
// used for internet access, is bundled beside it for the browser.
function copyWasmerSdk() {
  let outDir
  return {
    name: 'opcode:copy-wasmer-sdk',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      const sdk = resolve('node_modules/@wasmer/sdk')
      const target = join(outDir, 'wasmer-sdk')
      for (const dir of ['dist', 'pkg']) {
        cpSync(join(sdk, dir), join(target, dir), {
          recursive: true,
          filter: (path) => !/\.(d\.ts|map)$/.test(path),
        })
      }
      await esbuild({
        stdin: { contents: "export * from '@mercuryworkshop/wisp-js/client'", resolveDir: sdk, loader: 'js' },
        bundle: true,
        format: 'esm',
        platform: 'browser',
        minify: true,
        outfile: join(target, 'deps/wisp-client.js'),
        logLevel: 'warning',
      })
      const network = join(target, 'dist/wisp-network.js')
      const source = readFileSync(network, 'utf8')
      if (!source.includes('"@mercuryworkshop/wisp-js/client"')) throw new Error('The Wasmer SDK no longer imports @mercuryworkshop/wisp-js/client; update copyWasmerSdk().')
      writeFileSync(network, source.replace('"@mercuryworkshop/wisp-js/client"', '"../deps/wisp-client.js"'))
    },
  }
}

// v86 can open TCP connections into the emulated machine (its fetch network
// adapter does), but it only exports the emulator. Export that function too:
// the web preview uses it to reach servers running inside Linux machines.
function exportV86TcpConnect() {
  return {
    name: 'opcode:v86-tcp-connect',
    transform(code, id) {
      if (!id.split('?')[0].replace(/\\/g, '/').endsWith('/v86/build/libv86.mjs')) return null
      const match = /\.prototype\.connect=function\((\w+)\)\{return (\w+)\(\1,this\)\}/.exec(code)
      if (!match) {
        this.warn('v86 changed: its TCP connect function was not found, so previews of servers in Linux machines are off.')
        return null
      }
      return { code: `${code}\nexport const opcodeTcpConnect = ${match[2]};\n`, map: null }
    },
  }
}

// The licenses of the third-party code a build ships, in
// third-party-licenses.txt: the npm packages bundled into the app and its
// workers (recorded as they are bundled), and those copied in whole (`copied`,
// by copyWasmerSdk() and scripts/copy-npm-toolchains.mjs). The toolchains and
// Linux machines are described in THIRD_PARTY_NOTICES.md.
function thirdPartyLicenses(copied, files) {
  const packages = new Set([...copied].map((name) => resolve('node_modules', name)))
  const record = {
    name: 'opcode:record-packages',
    apply: 'build',
    transform(_, id) {
      const path = id.split('?')[0].replace(/\\/g, '/')
      const at = path.lastIndexOf('/node_modules/')
      if (at === -1 || id.startsWith('\0')) return null
      const parts = path.slice(at + '/node_modules/'.length).split('/')
      packages.add(path.slice(0, at + '/node_modules/'.length) + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/'))
      return null
    },
  }
  let outDir
  const write = {
    name: 'opcode:third-party-licenses',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const sections = []
      for (const dir of [...packages].sort()) {
        const { name, version, license } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const texts = readdirSync(dir)
          .filter((file) => /^(licen[cs]e|copying|notice|third-?party-?notices)/i.test(file))
          .map((file) => readFileSync(join(dir, file), 'utf8').trim())
        sections.push({ title: `${name} ${version} (${license ?? 'see below'})`, text: texts.join('\n\n') || `License: ${license}. The package includes no license file.` })
      }
      for (const { title, file } of files) sections.push({ title, text: readFileSync(file, 'utf8').trim() })
      const rule = '='.repeat(78)
      writeFileSync(
        join(outDir, 'third-party-licenses.txt'),
        `Third-party software in this build of Opcode, and its licenses.\n\nOpcode itself is free software under the GNU Affero General Public License,\nversion 3 or later; its source code and THIRD_PARTY_NOTICES.md (the\ntoolchains and Linux machines) are at https://github.com/tks98/opcode.\n\n${sections.map(({ title, text }) => `${rule}\n${title}\n${rule}\n\n${text}\n`).join('\n')}`,
      )
    },
  }
  return { record, write }
}

const licenses = thirdPartyLicenses(
  ['@wasmer/sdk', '@mercuryworkshop/wisp-js', 'webr', '@antonz/ruby-wasi', 'typescript', '@types/node', 'undici-types'],
  [
    { title: 'LLVM and Clang (in @yowasp/clang, and in the Rust toolchain)', file: 'licenses/LLVM.txt' },
    { title: 'Recursive Mono (src/assets/fonts, from Recursive)', file: 'src/assets/fonts/OFL.txt' },
  ],
)

export default defineConfig({
  // Relative asset URLs, so the build also works from a subpath
  // (e.g. https://user.github.io/opcode/).
  base: './',
  plugins: [svelte(), copyWasmerSdk(), exportV86TcpConnect(), licenses.record, licenses.write],
  optimizeDeps: {
    exclude: ['@wasmer/sdk', '@yowasp/clang', 'v86'],
  },
  worker: {
    format: 'es',
    plugins: () => [licenses.record],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
  server: {
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
  test: {
    include: ['tests/**/*.test.js'],
  },
})
