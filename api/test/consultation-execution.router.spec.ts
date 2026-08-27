import { describe, expect, it } from 'vitest';
import {
  classifyResearchError,
  publicResearchError,
} from '../src/modules/project/application/consultation-execution.router';

describe('ConsultationExecutionRouter 法律检索错误呈现', () => {
  it('将召回、正文读取和原文匹配失败分开分类', () => {
    expect(classifyResearchError(new Error('dsh Agent 未产生必需工具结果：search_similar_cases')))
      .toBe('RESEARCH_CASE_SEARCH_REQUIRED');
    expect(classifyResearchError(new Error('dsh Agent 未产生成功的法规检索结果')))
      .toBe('RESEARCH_SEARCH_REQUIRED');
    expect(classifyResearchError(new Error('dsh Agent 命中法规后未读取权威正文')))
      .toBe('RESEARCH_DETAIL_REQUIRED');
    expect(classifyResearchError(new Error('dsh Agent 法规原文与权威详情不匹配：abc')))
      .toBe('RESEARCH_QUOTE_MISMATCH');
  });

  it('对每种可修复的证据失败返回可理解文案', () => {
    expect(publicResearchError('RESEARCH_CITATION_MISSING'))
      .toBe('回答缺少已核验的法规来源，本次回答未保存');
    expect(publicResearchError('RESEARCH_QUOTE_MISMATCH'))
      .toBe('引用法条与权威正文不一致，本次回答已拦截，请重试');
    expect(publicResearchError('RESEARCH_TOOL_LIMIT_REACHED'))
      .toContain('检索步骤已达本轮上限');
  });
});
