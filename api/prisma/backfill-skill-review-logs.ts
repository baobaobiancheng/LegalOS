import 'dotenv/config';
import { PrismaClient, SkillReviewAction } from '@prisma/client';

/**
 * P1-09 技能审核日志回填脚本：把旧的 `Skill.reviewLog`(Json 数组) 迁移到 `SkillReviewLog` 表。
 * - 幂等：eventId = `legacy:${skillId}:${index}` 唯一，重复执行 upsert 跳过。
 * - --dry-run：只统计不写库。
 *
 * 用法：
 *   npx ts-node prisma/backfill-skill-review-logs.ts --dry-run
 *   npx ts-node prisma/backfill-skill-review-logs.ts
 */

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

const VALID_ACTIONS: SkillReviewAction[] = ['submit', 'withdraw', 'approve', 'reject', 'archive', 'restore'];

async function main(): Promise<void> {
  const skills = await prisma.skill.findMany({
    select: { id: true, slug: true, reviewLog: true },
  });

  let scanned = 0;
  let created = 0;
  let skipped = 0;
  let unparseable = 0;
  const bad: string[] = [];

  for (const s of skills) {
    const logs = s.reviewLog;
    if (!Array.isArray(logs) || logs.length === 0) continue;
    for (let i = 0; i < logs.length; i++) {
      scanned++;
      const el = (logs[i] ?? {}) as Record<string, unknown>;
      const action = String(el.action ?? '').toLowerCase();
      if (!VALID_ACTIONS.includes(action as SkillReviewAction)) {
        unparseable++;
        bad.push(`${s.slug}#${i}: 非法 action=${action}`);
        continue;
      }
      const eventId = `legacy:${s.id}:${i}`;
      const data = {
        eventId,
        skillId: s.id,
        action: action as SkillReviewAction,
        fromState: 'unknown',
        toState: 'unknown',
        actorId: String(el.reviewerId ?? 'unknown'),
        reason: el.reason ? String(el.reason) : null,
        createdAt: el.at ? new Date(String(el.at)) : new Date(),
      };
      if (DRY_RUN) {
        created++;
        continue;
      }
      const r = await prisma.skillReviewLog.upsert({ where: { eventId }, update: {}, create: data });
      if (r.id) created++;
      else skipped++;
    }
  }

  console.log(JSON.stringify({ scanned, created, skipped, unparseable, dryRun: DRY_RUN }, null, 2));
  if (bad.length) {
    console.log('未解析元素(前 20 条):');
    bad.slice(0, 20).forEach((b) => console.log('  ' + b));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
