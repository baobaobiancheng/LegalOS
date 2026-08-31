import { createHash } from 'node:crypto';

export const OUTBOX_EVENT_CRM_REVIEW_RESULT_DELIVER = 'crm.review-result.deliver';

/** 同一 CRM 审核任务只交付一次权威结果，重试复用同一 Outbox 事件。 */
export function crmReviewDeliveryOutboxDedupKey(sourceAppId: string, crmTaskId: string): string {
  const digest = createHash('sha256')
    .update(sourceAppId, 'utf8')
    .update('\0')
    .update(crmTaskId, 'utf8')
    .digest('hex');
  return `crm:${digest}:review-result:v1`;
}
