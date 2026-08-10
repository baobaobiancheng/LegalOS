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

// CRM 契约内部核对（plan-eng-review 2026-08-10）：接口 ↔ 代码位置，符号级断言。
// 文档已删内部附录（CRM-facing），映射表移入本脚本，防文档与代码失效；CI 同样生效。
const CRM_SYMBOLS = [
  ['api/src/modules/project/project.controller.ts', 'create'], // 建单入口 POST /projects
  ['api/src/modules/project/application/create-project.use-case.ts', 'CreateProjectUseCase.execute'], // 建单用例(事务+幂等+crmReference)
  ['api/src/modules/project/dto/create-project.dto.ts', 'crmReference'], // crmReference 入参
  ['api/src/modules/project/adapters/adapter.interfaces.ts', 'CrmAdapter'], // CRM 适配器抽象
  ['api/src/modules/project/adapters/mock-crm.adapter.ts', 'MockCrmAdapter'], // Mock 实现
  ['api/src/modules/project/project.service.ts', 'reply'], // 回传触发(writeBack)
  ['api/src/modules/project/project.service.ts', 'executeStream'], // AI 自动回传(无 CRM 调用)
  ['api/src/modules/project/project.controller.ts', 'transfer'], // 转派(不调 CRM)
  ['api/src/modules/contract/contract.controller.ts', 'upload'], // 文件上传
  ['api/src/modules/contract/contract.service.ts', 'uploadFile'], // 附件类型(仅 revised|final)
  ['api/src/modules/project/application/create-project.use-case.ts', 'idempotencyKey'], // 幂等键
]
for (const [file, symbol] of CRM_SYMBOLS) {
  const abs = resolve(ROOT, file)
  if (!existsSync(abs)) {
    FAILS.push(`CRM 契约映射:文件不存在 ${file}`)
    continue
  }
  if (!hasSymbol(readFileSync(abs, 'utf8'), symbol)) {
    FAILS.push(`CRM 契约映射:${file} 中找不到符号 ${symbol}`)
  }
}

if (FAILS.length) {
  console.error('文档校验失败:')
  FAILS.forEach((f) => console.error('  ✗ ' + f))
  process.exit(1)
}
console.log(`✓ 文档校验通过 (${docs.length} 个文件)`)
