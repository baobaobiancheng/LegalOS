import { describe, expect, it } from 'vitest';
import {
  classifyResearchError,
  publicResearchError,
} from '../src/modules/project/application/consultation-execution.router';

describe('ConsultationExecutionRouter 法律检索错误呈现', () => {
  it('将工具未调用与证据核验失败分开分类', () => {
    expect(classifyResearchError(new Error('dsh Agent 命中法规后未读取权威正文')))
      .toBe('RESEARCH_TOOL_REQUIRED');
    expect(classifyResearchError(new Error('dsh Agent 法规原文与权威详情不匹配：abc')))
      .toBe('RESEARCH_EVIDENCE_INVALID');
  });

  it('对证据失败返回可理解且不泄漏供应商细节的文案', () => {
    expect(publicResearchError('RESEARCH_EVIDENCE_INVALID'))
      .toBe('法规证据核验未通过，本次回答未保存，请重试或调整问题');
  });
});
