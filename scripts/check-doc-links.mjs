#!/usr/bin/env node
/**
 * P2-05 文档校验：相对链接存在性(大小写敏感) + 陈旧内容断言。
 * 无外部服务依赖,CI 作为强制 job 执行;任一失败 exit 1。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

const ROOT = process.cwd()
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.md')) out.push(p)
  }
  return out
}
const docs = ['README.md', 'DEPLOY.md']
try { docs.push(...walk('docs')) } catch { /* docs/ 不存在则跳过 */ }

/**
 * 符号断言：检查 src 中是否存在 `Class`/`Class.method`/`method`/字段。
 * - 裸方法名按 `name(` 形式匹配（防把同名类/注释当命中）；
 * - `Class.method` 拆开校验：class 声明 + 方法定义都存在。
 */
const hasSymbol = (src, symbol) => {
  const dot = symbol.lastIndexOf('.')
  if (dot > 0) {
    const cls = symbol.slice(0, dot)
    const method = symbol.slice(dot + 1)
    return src.includes(`class ${cls}`) && new RegExp(`\\b${method}\\s*\\(`).test(src)
  }
  if (new RegExp(`\\b${symbol}\\s*\\(`).test(src)) return true // 方法
  return src.includes(symbol) // 字段/类名/接口名
}

const FAILS = []
for (const doc of docs) {
  if (!existsSync(doc)) continue
  const text = readFileSync(doc, 'utf8')
  const linkRe = /\[[^\]]*\]\(([^)#\s]+)\)/g
  let m
  while ((m = linkRe.exec(text))) {
    const target = m[1]
    if (/^(https?:)?\/\//.test(target) || target.startsWith('#')) continue
    const abs = resolve(dirname(doc), target)
    if (!existsSync(abs)) FAILS.push(`${doc}: 链接不存在 ${target}`)
  }
  if (/admin123|legal123|biz123/.test(text)) FAILS.push(`${doc}: 含固定种子密码`)
  if (/Swagger 文档：http/.test(text)) FAILS.push(`${doc}: 含不存在的 Swagger 地址`)
  if (/LegalPlatform\//.test(text)) FAILS.push(`${doc}: 含旧目录名 LegalPlatform`)
  if (/\b7 个 migration\b|\b74\/74 测试\b/.test(text)) FAILS.push(`${doc}: 含硬编码迁移/测试数量`)
}

// CRM 接口需求文档在 git 仓库外（产品需求文档/ 是仓库兄弟目录）：
// 本机存在时校验其「附录 B 接口↔代码映射表」引用的文件/符号仍存在；CI 无此路径则跳过。
const CRM_DOC = resolve(ROOT, '../产品需求文档/V0.1.0/后期待办/CRM合同审核对接-接口需求文档.md')
if (existsSync(CRM_DOC)) {
  const crmText = readFileSync(CRM_DOC, 'utf8')
  // 附录 B 行格式：`文件路径`:`符号`(...)
  const symbolRe = /`([^`]+)`:`([^`]+)`/g
  let m2, n = 0
  while ((m2 = symbolRe.exec(crmText))) {
    const file = m2[1]
    const symbol = m2[2]
    const abs = resolve(ROOT, file)
    if (!existsSync(abs)) {
      FAILS.push(`${CRM_DOC}: 映射表引用文件不存在 ${file}`)
      continue
    }
    if (!hasSymbol(readFileSync(abs, 'utf8'), symbol)) {
      FAILS.push(`${CRM_DOC}: ${file} 中找不到符号 ${symbol}`)
    }
    n++
  }
  if (n === 0) FAILS.push(`${CRM_DOC}: 未匹配到任何「文件:符号」映射（附录 B 格式可能被改动）`)
  docs.push('CRM 合同审核对接-接口需求文档.md')
}

if (FAILS.length) {
  console.error('文档校验失败:')
  FAILS.forEach((f) => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log(`✓ 文档校验通过 (${docs.length} 个文件)`)
