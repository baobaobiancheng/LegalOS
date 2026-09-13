import { Prisma } from '@prisma/client';
import { dingtalkMemberOutboxDedupKey, OUTBOX_EVENT_DINGTALK_MEMBER_ADD } from './create-project.use-case';

/** 与指派同事务提交；无群时由同一任务补建，CRM A1 保持不自动建群的契约。 */
export async function queueAssignmentNotification(
  tx: Pick<Prisma.TransactionClient, 'outboxEvent'>,
  project: { id: string; sourceAppId?: string | null; route: string },
  userId: string,
  previousUserId: string | null,
): Promise<void> {
  if (project.sourceAppId || project.route !== 'legalbp' || userId === previousUserId) return;
  try {
    await tx.outboxEvent.create({ data: {
      eventType: OUTBOX_EVENT_DINGTALK_MEMBER_ADD,
      aggregateType: 'project', aggregateId: project.id, projectId: project.id,
      dedupKey: dingtalkMemberOutboxDedupKey(project.id, userId),
      payload: { projectId: project.id, userId },
    } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
  }
}
