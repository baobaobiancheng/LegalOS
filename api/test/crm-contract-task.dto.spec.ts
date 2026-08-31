import { describe, expect, it } from 'vitest';
import { parseCrmContractTaskPayload } from '../src/modules/crm-integration/dto/crm-contract-task.dto';

describe('CRM A1 payload DTO', () => {
  it('规范化字符串并校验真实日期', async () => {
    const dto = await parseCrmContractTaskPayload(JSON.stringify({
      ...valid(),
      currentNodeAssignee: ' Legal.User ',
      contractStartDate: '2026-02-01',
      contractEndDate: '2026-02-28',
    }));
    expect(dto.currentNodeAssignee).toBe('Legal.User');

    await expect(parseCrmContractTaskPayload(JSON.stringify({
      ...valid(),
      contractStartDate: '2026-02-30',
    }))).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'INVALID_PARAM' }),
    });
  });

  it('拒绝 payload 伪造 sourceAppId、未知字段和 trim 后的空必填值', async () => {
    for (const payload of [
      { ...valid(), sourceAppId: 'spoofed' },
      { ...valid(), unknownField: 'x' },
      { ...valid(), applicant: '   ' },
    ]) {
      await expect(parseCrmContractTaskPayload(JSON.stringify(payload))).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: 'INVALID_PARAM' }),
      });
    }
  });
});

function valid() {
  return {
    crmTaskId: 'task-10086',
    contractNo: 'HT-2026-001',
    contractApplyType: 'NEW',
    contractType: 'NORMAL',
    currentAuditStatus: '法务审核中',
    currentAuditNode: '法务审核',
    currentNodeAssignee: 'legal.user',
    applicant: '张伟',
    customerName: '某某科技有限公司',
    signSubject: '我司',
  };
}
