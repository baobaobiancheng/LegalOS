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

if (FAILS.length) {
  console.error('文档校验失败:')
  FAILS.forEach((f) => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log(`✓ 文档校验通过 (${docs.length} 个文件)`)
