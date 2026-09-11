#!/usr/bin/env node
/**
 * 校验 Windows 桌面端产物确实是 64 位（x64），并输出可发布的顶层文件清单。
 *
 * 为什么做二进制级校验，而不是只看文件名：
 *   上游 desktop-build-paths.mjs 的 SUPPORTED_TARGETS 只有 mac-arm64 / mac-x64 / win-x64，
 *   package-target.ts 里 win-x64 硬编码 arch:'x64' 且强制要求 Windows x64 构建主机，
 *   electron-builder.config.mjs 的 afterPack 又会用 {platform:'win32', arch:'x64'} 校验捆绑的
 *   运行时树。也就是说上游本来就没有 32 位通道。这一层是防止将来上游改动把非 x64 产物
 *   悄悄带进来的「不可回退的保证」，而不是在修 bug。
 *
 * 两条必须讲清楚的边界（否则这道闸门会误伤）：
 *   1. NSIS 只有 32 位实现，electron-builder 打出的 .exe 安装包外壳因此是 i386 PE。
 *      外壳位数与安装后的应用无关，所以对安装包外壳只报告、不判定失败。
 *   2. 应用本体里本来就合法地带着多架构的附带程序 —— 实测 payload 含
 *      runtime/pnpm/dist/vendor/fastlist-0.3.0-x86.exe（i386）和
 *      node-pty/third_party/conpty/<版本>/win10-arm64/OpenConsole.exe（ARM64）。
 *      它们不是「应用」，所以只在其余 PE 文件里告警。
 *   硬性断言只落在真正会被执行的两个东西上：主程序 + 随包分发的 node.exe。
 *
 * 用法: node verify-win-artifacts.mjs <产物目录> [清单输出文件]
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

const PE_MACHINE = new Map([
  [0x014c, 'i386 (32-bit)'],
  [0x8664, 'AMD64 (x64)'],
  [0xaa64, 'ARM64'],
  [0x01c4, 'ARMv7'],
  [0x0200, 'IA64'],
])

const I386 = 0x014c
const AMD64 = 0x8664
/** 顶层产物文件名里出现这些片段即说明不是 x64（或混入了别的架构）。 */
const NAME_MARKERS = ['ia32', 'x86', 'win32', 'arm64', 'armv7']
/** 不发布到 Release 的构建元数据（仍上传为 Actions artifact，便于排查）。 */
const NON_RELEASE_FILES = new Set(['builder-debug.yml'])

/** 读 PE 头的 Machine 字段；非 PE 文件返回 error 而不抛异常。 */
function readPeMachine(file) {
  const fd = openSync(file, 'r')
  try {
    const dos = Buffer.alloc(0x40)
    if (readSync(fd, dos, 0, 0x40, 0) < 0x40) return { error: 'DOS 头被截断' }
    if (dos.readUInt16LE(0) !== 0x5a4d) return { error: '不是 MZ 可执行文件' }
    const peOffset = dos.readUInt32LE(0x3c)
    const header = Buffer.alloc(6)
    if (readSync(fd, header, 0, 6, peOffset) < 6) return { error: 'PE 头被截断' }
    if (header.readUInt32LE(0) !== 0x00004550) return { error: '缺少 PE\\0\\0 签名' }
    const machine = header.readUInt16LE(4)
    return { machine, label: PE_MACHINE.get(machine) ?? `未知 (0x${machine.toString(16)})` }
  } finally {
    closeSync(fd)
  }
}

/** 递归收集匹配的文件路径。 */
function collect(root, pattern) {
  const found = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && pattern.test(entry.name)) found.push(full)
    }
  }
  walk(root)
  return found
}

/** 把 PE 文件判定为 AMD64，否则记一条失败。 */
function assertAmd64(file, label, displayPath, failures, log) {
  const result = readPeMachine(file)
  if (result.machine !== AMD64) {
    failures.push(`${label}不是 AMD64：${displayPath} 实际 ${result.label ?? result.error}`)
    return false
  }
  log.push(`✅ ${label} ${displayPath} = ${result.label}`)
  return true
}

/**
 * 校验一个 Windows x64 产物目录。
 * @param {string} artifactsDir 产物目录。
 * @returns {{ failures: string[], warnings: string[], topFiles: string[], releaseFiles: string[], log: string[] }}
 */
export function verifyWinArtifacts(artifactsDir) {
  const failures = []
  const warnings = []
  const log = []

  if (!existsSync(artifactsDir)) {
    failures.push(`未找到产物目录 ${artifactsDir}`)
    return { failures, warnings, topFiles: [], releaseFiles: [], log }
  }

  const entries = readdirSync(artifactsDir, { withFileTypes: true })
  const topFiles = entries
    .filter(entry => entry.isFile())
    .map(entry => join(artifactsDir, entry.name))
    .sort()
  const topDirs = entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  log.push('== 顶层文件（可发布）==')
  for (const file of topFiles) {
    log.push(`  ${(statSync(file).size / 1024 / 1024).toFixed(1).padStart(9)} MB  ${basename(file)}`)
  }
  log.push('== 顶层目录（不发布）==')
  for (const dir of topDirs) log.push(`  ${dir}`)

  // --- 1. 文件名层面的架构闸门 ---------------------------------------------
  for (const file of topFiles) {
    const lower = basename(file).toLowerCase()
    const hit = NAME_MARKERS.find(marker => lower.includes(marker))
    if (hit === undefined) continue
    if (hit === 'ia32') failures.push(`产物文件名含 ia32（32 位）：${basename(file)}`)
    else warnings.push(`产物文件名含 '${hit}'，请确认非 32 位：${basename(file)}`)
  }

  const installers = topFiles.filter(file => /\.exe$/i.test(file))
  if (installers.length === 0) failures.push('未找到任何 .exe 安装包')
  for (const installer of installers) {
    if (!/x64/i.test(basename(installer))) {
      failures.push(`安装包名未包含 x64：${basename(installer)}`)
    }
  }

  for (const stray of ['win-ia32-unpacked', 'win-arm64-unpacked']) {
    if (topDirs.includes(stray)) failures.push(`出现异构未打包目录 ${stray}`)
  }

  // --- 2. 二进制层面：应用本体必须是 AMD64 ---------------------------------
  const unpackedDir = join(artifactsDir, 'win-unpacked')
  if (!existsSync(unpackedDir)) {
    failures.push('未找到 win-unpacked 目录，无法做二进制级架构校验')
  } else {
    const mainExe = join(unpackedDir, 'DeepSeek Harness.exe')
    if (!existsSync(mainExe)) {
      failures.push(`win-unpacked 下未找到主程序 'DeepSeek Harness.exe'`)
    } else {
      assertAmd64(mainExe, '主程序', 'DeepSeek Harness.exe', failures, log)
    }

    // 真正执行 JS 的是随包分发的 node.exe，它的位数同样必须是 AMD64。
    const nodeExes = collect(unpackedDir, /^node\.exe$/i)
    if (nodeExes.length === 0) {
      warnings.push('win-unpacked 下未找到 node.exe，无法校验捆绑运行时的位数')
    }
    for (const nodeExe of nodeExes) {
      assertAmd64(nodeExe, '捆绑运行时', nodeExe.slice(unpackedDir.length + 1), failures, log)
    }

    // 其余 PE 文件只告警：payload 合法地带有 fastlist-x86.exe、win10-arm64/OpenConsole.exe。
    const others = [...collect(unpackedDir, /\.exe$/i), ...collect(unpackedDir, /\.dll$/i)]
      .filter(file => file !== mainExe && basename(file).toLowerCase() !== 'node.exe')
    const nonAmd64 = []
    for (const file of others) {
      const result = readPeMachine(file)
      if (result.machine !== undefined && result.machine !== AMD64) {
        nonAmd64.push(`${file.slice(unpackedDir.length + 1)} = ${result.label}`)
      }
    }
    if (nonAmd64.length > 0) {
      warnings.push(`附带 PE 文件中非 AMD64 的有 ${nonAmd64.length} 个（多架构 payload，属正常）：\n    ${nonAmd64.join('\n    ')}`)
    }
    log.push(`（附带 PE 文件扫描 ${others.length} 个，其中非 AMD64 ${nonAmd64.length} 个）`)
  }

  // --- 3. 安装包外壳：只报告（NSIS 外壳固定 32 位） -------------------------
  for (const installer of installers) {
    const result = readPeMachine(installer)
    const label = result.label ?? result.error
    log.push(`ℹ️  安装包外壳 ${basename(installer)} = ${label}`)
    if (result.machine === I386) {
      log.push('    说明：NSIS 安装包外壳固定为 32 位引导程序，与安装后的应用位数无关。')
    } else if (result.machine !== AMD64) {
      warnings.push(`安装包外壳架构异常：${basename(installer)} = ${label}`)
    }
  }

  const releaseFiles = topFiles.filter(file => !NON_RELEASE_FILES.has(basename(file)))
  return { failures, warnings, topFiles, releaseFiles, log }
}

/** CLI 入口。 */
function main() {
  const artifactsDir = process.argv[2]
  const listFile = process.argv[3]
  if (artifactsDir === undefined || artifactsDir === '') {
    console.error('用法: node verify-win-artifacts.mjs <产物目录> [清单输出文件]')
    process.exit(2)
  }

  const { failures, warnings, topFiles, releaseFiles, log } = verifyWinArtifacts(artifactsDir)
  for (const line of log) console.log(line)
  console.log('')

  for (const warning of warnings) console.log(`::warning::${warning}`)
  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${failure}`)
    console.error(`\n架构校验失败：${failures.length} 项`)
    process.exit(1)
  }

  console.log(`✅ 架构校验通过：产物为 Windows x64（64 位），顶层 ${topFiles.length} 个文件，` +
    `其中 ${releaseFiles.length} 个用于 Release`)
  if (listFile !== undefined && listFile !== '') {
    // 统一写正斜杠：消费方是 Git Bash + gh.exe，避免反斜杠路径在 MSYS 下产生歧义。
    const content = releaseFiles.map(file => file.replaceAll('\\', '/')).join('\n')
    writeFileSync(listFile, releaseFiles.length > 0 ? `${content}\n` : '')
    console.log(`已写出发布清单: ${listFile}`)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) main()
