#!/usr/bin/env node
/**
 * verify-win-artifacts.mjs 的回归测试。
 *
 * 用例形态刻意对齐真实的 Windows x64 产物树（来自一次成功的
 * package:desktop:win:x64:unsigned 构建）：
 *   - 顶层只有 builder-debug.yml / <name>-win-x64.exe / <name>-win-x64.exe.blockmap
 *   - win-unpacked/DeepSeek Harness.exe            → AMD64，硬断言
 *   - win-unpacked/resources/runtime/node/node.exe → AMD64，硬断言
 *   - resources/runtime/pnpm/dist/vendor/fastlist-0.3.0-x86.exe   → i386，合法附带，只告警
 *   - resources/dsh/node_modules/node-pty/third_party/conpty/<版本>/win10-arm64/OpenConsole.exe
 *                                                  → ARM64，合法附带，只告警
 * 最后两条是关键：如果对全部 .exe 一律硬失败，真实构建会被误判为失败。
 *
 * 用法: node verify-win-artifacts.test.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyWinArtifacts } from './verify-win-artifacts.mjs'

const AMD64 = 0x8664
const I386 = 0x014c
const ARM64 = 0xaa64

/** 造一个最小可用 PE 头：MZ + e_lfanew + PE\0\0 + Machine。 */
function makePe(machine) {
  const buf = Buffer.alloc(0x200)
  buf.writeUInt16LE(0x5a4d, 0)
  buf.writeUInt32LE(0x80, 0x3c)
  buf.writeUInt32LE(0x00004550, 0x80)
  buf.writeUInt16LE(machine, 0x84)
  return buf
}

/**
 * 铺一个产物目录。
 * @param {object} shape 各文件的位数；缺省即使用真实形态。
 * @returns {string} 产物目录。
 */
function stage(shape = {}) {
  const {
    mainExe = AMD64,
    nodeExe = AMD64,
    installerName = 'deepseek-harness-0.1.5-rc.2-win-x64.exe',
    installerPe = I386,
    extraExes = [],
    skipUnpacked = false,
  } = shape

  const root = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
  const dir = join(root, 'unsigned-artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'builder-debug.yml'), 'debug: true\n')
  writeFileSync(join(dir, installerName), makePe(installerPe))
  writeFileSync(join(dir, 'deepseek-harness-0.1.5-rc.2-win-x64.exe.blockmap'), 'not-a-pe')

  if (!skipUnpacked) {
    const unpacked = join(dir, 'win-unpacked')
    mkdirSync(join(unpacked, 'resources', 'runtime', 'node'), { recursive: true })
    writeFileSync(join(unpacked, 'DeepSeek Harness.exe'), makePe(mainExe))
    writeFileSync(join(unpacked, 'resources', 'runtime', 'node', 'node.exe'), makePe(nodeExe))
    for (const [relPath, machine] of extraExes) {
      const full = join(unpacked, relPath)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, makePe(machine))
    }
  }
  return dir
}

const REAL_WORLD_EXTRA = [
  ['resources/runtime/pnpm/dist/vendor/fastlist-0.3.0-x86.exe', I386],
  ['resources/runtime/pnpm/dist/vendor/fastlist-0.3.0-x64.exe', AMD64],
  ['resources/dsh/node_modules/node-pty/third_party/conpty/1.25.260303002/win10-arm64/OpenConsole.exe', ARM64],
  ['resources/dsh/node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe', AMD64],
  ['resources/dsh/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe', AMD64],
]

const CASES = [
  { name: '真实形态：主程序/捆绑 node 为 x64，附带含 x86+arm64 → 放行', shape: { extraExes: REAL_WORLD_EXTRA }, expectFail: false },
  { name: '最小形态：只有主程序与捆绑 node.exe', shape: {}, expectFail: false },
  { name: '主程序是 32 位 → 拦截', shape: { mainExe: I386, extraExes: REAL_WORLD_EXTRA }, expectFail: true },
  { name: '捆绑 node.exe 是 32 位 → 拦截', shape: { nodeExe: I386, extraExes: REAL_WORLD_EXTRA }, expectFail: true },
  { name: '主程序是 ARM64（异构）→ 拦截', shape: { mainExe: ARM64 }, expectFail: true },
  { name: '安装包文件名是 win-ia32 → 拦截', shape: { installerName: 'deepseek-harness-0.1.5-rc.2-win-ia32.exe' }, expectFail: true },
  { name: '缺少 win-unpacked → 拦截', shape: { skipUnpacked: true }, expectFail: true },
  { name: '安装包外壳是 i386（NSIS 正常）→ 放行', shape: { installerPe: I386, extraExes: REAL_WORLD_EXTRA }, expectFail: false },
]

let passed = 0
let failed = 0
const dirs = []
try {
  for (const testCase of CASES) {
    const dir = stage(testCase.shape)
    dirs.push(dir)
    const result = verifyWinArtifacts(dir)
    const didFail = result.failures.length > 0
    const ok = didFail === testCase.expectFail
    if (ok) passed++
    else failed++
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${testCase.name}`)
    if (!ok) {
      console.log(`      期望 ${testCase.expectFail ? '拦截' : '放行'}，实际 ${didFail ? '拦截' : '放行'}`)
      for (const failure of result.failures) console.log(`      failure: ${failure}`)
    } else if (didFail) {
      for (const failure of result.failures) console.log(`      (已拦截) ${failure}`)
    }
  }
} finally {
  for (const dir of dirs) {
    try {
      rmSync(join(dir, '..'), { recursive: true, force: true })
    } catch {
      // 清理失败不影响测试结论
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${CASES.length} total`)
if (failed > 0) process.exit(1)
