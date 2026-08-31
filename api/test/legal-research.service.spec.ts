import { describe, expect, it, vi } from 'vitest';
import {
  DshExecutionHandle,
  DshResearchEvidenceError,
  validateResearchCompletion,
} from '../src/common/services/dsh.service';
import { isCaseLikeTitle, LegalResearchService } from '../src/modules/legal-research/legal-research.service';
import { ConsultationExecutionRouter } from '../src/modules/project/application/consultation-execution.router';

describe('LegalResearchService', () => {
  it('快捷检索如实传递用户关键词，不用硬编码规则冒充 AI 意图理解', async () => {
    const searchLaws = vi.fn().mockResolvedValue({
      toolName: 'lawstar_data_professional_query', status: 'success_hit', count: 1,
      page: 2, pageSize: 10, totalPages: 3, records: [
        { lawName: '中华人民共和国劳动合同法' },
        { lawName: '陈某诉某公司劳动合同纠纷案' },
      ],
    });
    const service = new LegalResearchService({ searchLaws } as any, {} as any, {} as any, {} as any);

    const result = await service.searchLaws({ keyword: '劳动合同纠纷', page: 2, rows: 10 });

    expect(searchLaws).toHaveBeenCalledWith(
      { keyword: '劳动合同纠纷', page: 2, rows: 10 },
      undefined,
      { refresh: undefined },
    );
    expect(result).toMatchObject({
      requestedKeyword: '劳动合同纠纷',
      searchedKeyword: '劳动合同纠纷',
      filteredCaseLikeCount: 1,
      records: [{ lawName: '中华人民共和国劳动合同法' }],
    });
  });

  it('只排除明确的案例型标题，不误伤司法解释', () => {
    expect(isCaseLikeTitle('指导性案例180号：孙某诉某公司劳动合同纠纷案')).toBe(true);
    expect(isCaseLikeTitle('最高人民法院关于审理劳动争议案件适用法律问题的解释')).toBe(false);
  });

  it('成功检索且读取详情后，不因模型引文与正文不一致而拦截', () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const completion = {
      text: `> [法规原文｜ID:${lawId}｜条文:第一条] 这是并不存在于法规正文中的引用。`,
      dshSessionId: 'dsh-partial',
      toolCalls: [
        { callId: 's1', name: 'search_laws', arguments: { keyword: '公司法' } },
        { callId: 'd1', name: 'get_law_detail', arguments: { lawId } },
      ],
      toolResults: [
        {
          callId: 's1', name: 'search_laws', isError: false,
          result: { records: [{ recordId: lawId, lawName: '中华人民共和国公司法' }] },
        },
        {
          callId: 'd1', name: 'get_law_detail', isError: false,
          result: { recordId: lawId, contentBlocks: [{ text: '第一条 为了规范公司的组织和行为，制定本法。' }] },
        },
      ],
    } as any;

    expect(() => validateResearchCompletion('law_search', completion)).not.toThrow();
  });

  it('AI 搜法返回结构化报告并记录开始与成功审计', async () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const original = '经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资。';
    const handle = new DshExecutionHandle();
    const executeStream = vi.fn().mockImplementation(async () => {
      setImmediate(() => handle.emit('done', {
        text: JSON.stringify({
          title: '经济补偿法律检索报告', scope: '劳动合同领域现行法规', summary: '依法计算经济补偿。',
          answer: `结论 ID: ${lawId}`,
          sections: [{ title: '计算标准', content: '按工作年限计算。', sourceIds: [lawId] }],
          evidenceQuotes: [{ recordId: lawId, article: '第四十七条', text: original }],
          limitations: ['具体金额取决于工资基数。'],
        }),
        dshSessionId: 'dsh-report-1',
        toolCalls: [
          { callId: 's1', name: 'search_laws', arguments: { keyword: '经济补偿' } },
          { callId: 'd1', name: 'get_law_details', arguments: { lawIds: [lawId], query: '经济补偿' } },
        ],
        toolResults: [
          { callId: 's1', name: 'search_laws', isError: false, result: { records: [{ recordId: lawId, lawName: '劳动合同法' }] } },
          { callId: 'd1', name: 'get_law_details', isError: false, result: { toolName: 'get_law_details', details: [{ recordId: lawId, lawName: '劳动合同法', issuingOrgan: null, issuingNo: null, releaseDate: null, implementDate: null, timeliness: '现行有效', contentBlocks: [{ text: original }] }] } },
        ],
      }));
      return handle;
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new LegalResearchService({} as any, {
      executeStream,
      getToolCallLimit: () => 5,
    } as any, { record } as any, {} as any);

    const result = await service.aiSearch(
      { query: '经济补偿如何计算' },
      { id: 'legal-1', role: 'legal_bp' as any },
    );

    expect(executeStream).toHaveBeenCalledWith(expect.stringContaining('最多调用工具 5 次'), expect.objectContaining({
      sessionId: 'legal-research:legal-1', researchCapability: 'law_search', requireResearchTool: true,
    }));
    expect(result.reportId).toBe('dsh-report-1');
    expect(result.report.sources[0]).toMatchObject({ recordId: lawId, lawName: '劳动合同法' });
    expect(result.trace.report?.title).toBe('经济补偿法律检索报告');
    expect(record).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'ai.legal_research.succeeded' }));
  });

  it('SSE 先输出真实检索进度，持久化成功后再逐段输出已校验报告', async () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const original = '经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资。';
    const handle = new DshExecutionHandle();
    const timeline: string[] = [];
    const executeStream = vi.fn().mockImplementation(async () => {
      setImmediate(() => {
        handle.emit('tool_call', { callId: 's1', name: 'search_laws', arguments: { keyword: '经济补偿' } });
        handle.emit('tool_result', { callId: 's1', name: 'search_laws', isError: false, result: { records: [{ recordId: lawId, lawName: '劳动合同法' }] } });
        handle.emit('tool_call', { callId: 'd1', name: 'get_law_detail', arguments: { lawId } });
        handle.emit('tool_result', { callId: 'd1', name: 'get_law_detail', isError: false, result: { recordId: lawId, lawName: '劳动合同法', contentBlocks: [{ text: original }] } });
        handle.emit('done', {
          text: JSON.stringify({
            title: '经济补偿检索报告',
            scope: '劳动合同法',
            summary: '已核验经济补偿计算规则。',
            understanding: {
              queryType: 'legal_issue', analysis: '需要判断经济补偿的计算口径。', retrievalPlan: '检索劳动合同法并读取正文。',
              knownFacts: ['劳动关系已解除'], legalIssues: ['经济补偿计算'],
              factChanges: { added: [], corrected: [], removed: [] },
            },
            answer: '应依据已核验的劳动合同法计算。',
            sections: [{ title: '计算规则', content: '按工作年限计算。', sourceIds: [lawId] }],
            evidenceQuotes: [{ recordId: lawId, article: '第四十七条', text: original }],
            limitations: ['工资基数需结合个案确认。'],
          }),
          dshSessionId: 'dsh-stream-1',
          toolCalls: [],
          toolResults: [
            { callId: 's1', name: 'search_laws', isError: false, result: { records: [{ recordId: lawId, lawName: '劳动合同法' }] } },
            { callId: 'd1', name: 'get_law_detail', isError: false, result: { recordId: lawId, lawName: '劳动合同法', contentBlocks: [{ text: original }] } },
          ],
        });
      });
      return handle;
    });
    const sessions = {
      prepareTurn: vi.fn().mockResolvedValue({
        conversationId: 'conversation-1', contextVersion: 1, runId: 'turn-1', userMessageId: 'message-1',
        query: '经济补偿如何计算', operation: 'new', turnContext: { operation: 'new', knownFacts: [], legalIssues: [] },
      }),
      completeTurn: vi.fn().mockImplementation(async () => { timeline.push('persisted'); }),
      failTurn: vi.fn(),
    };
    const service = new LegalResearchService({} as any, {
      executeStream,
      getToolCallLimit: () => 5,
    } as any, { record: vi.fn().mockResolvedValue(undefined) } as any, sessions as any);

    await service.streamAiSearch(
      { query: '经济补偿如何计算' },
      { id: 'legal-1', role: 'legal_bp' as any },
      undefined,
      new AbortController().signal,
      (event) => timeline.push(event.type),
    );

    expect(timeline).toContain('research_metrics');
    expect(timeline).toContain('report_summary');
    expect(timeline.indexOf('research_stage')).toBeLessThan(timeline.indexOf('persisted'));
    expect(timeline.indexOf('persisted')).toBeLessThan(timeline.indexOf('report_start'));
    expect(timeline.at(-1)).toBe('report_completed');
  });

  it('报告结构解析失败时，独立搜法降级展示已读取的权威原文', async () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const original = '有限责任公司股东认缴的出资额由股东按照公司章程的规定自公司成立之日起五年内缴足。';
    const partialResult = {
      text: '这不是合法的结构化报告，绝不应展示。',
      dshSessionId: 'dsh-degraded-1',
      toolCalls: [
        { callId: 's1', name: 'search_laws', arguments: { keyword: '公司法 认缴期限' } },
        { callId: 'd1', name: 'get_law_details', arguments: { lawIds: [lawId] } },
      ],
      toolResults: [
        { callId: 's1', name: 'search_laws', isError: false, result: { records: [{ recordId: lawId, lawName: '中华人民共和国公司法', issuingOrgan: '全国人大常委会', timeliness: '现行有效' }] } },
        { callId: 'd1', name: 'get_law_details', isError: false, result: { toolName: 'get_law_details', details: [{ recordId: lawId, lawName: '中华人民共和国公司法', issuingOrgan: '全国人大常委会', issuingNo: null, releaseDate: null, implementDate: null, timeliness: '现行有效', contentBlocks: [{ kind: 'paragraph', text: original }] }] } },
      ],
    } as any;
    const handle = new DshExecutionHandle();
    const executeStream = vi.fn().mockImplementation(async () => {
      setImmediate(() => handle.emit('done', partialResult));
      return handle;
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new LegalResearchService({} as any, {
      executeStream,
      getToolCallLimit: () => 5,
    } as any, { record } as any, {} as any);

    const result = await service.aiSearch(
      { query: '2024年新《公司法》注册资本认缴期限' },
      { id: 'legal-1', role: 'legal_bp' as any },
    );

    expect(result).toMatchObject({
      reportId: 'dsh-degraded-1',
      degraded: true,
      warning: {
        code: 'RESEARCH_REPORT_INVALID',
        message: expect.stringContaining('报告结构不完整'),
      },
    });
    expect(result.warning.message).not.toContain('本次回答未保存');
    expect(result.report.summary).toContain('AI 生成内容未满足运行条件');
    expect(result.report.sources[0].articles[0].text).toBe(original);
    expect(JSON.stringify(result)).not.toContain('这不是合法的结构化报告');
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'ai.legal_research.degraded', outcome: 'partial', reasonCode: 'RESEARCH_REPORT_INVALID',
    }));
  });

  it('工具超限时使用已完成的召回结果返回安全降级报告', async () => {
    const lawId = 'D6592443DA000EF8D692CE667E947A69';
    const partialResult = {
      text: '',
      dshSessionId: 'dsh-tool-limit',
      toolCalls: [
        { callId: 's1', name: 'search_laws_semantic', arguments: { query: '员工解除劳动合同如何补偿' } },
        { callId: 's2', name: 'search_laws', arguments: { keyword: '经济补偿' } },
      ],
      toolResults: [{
        callId: 's1', name: 'search_laws_semantic', isError: false,
        result: {
          records: [{ recordId: lawId, lawName: '中华人民共和国劳动合同法', issuingOrgan: '全国人大常委会', timeliness: '现行有效' }],
        },
      }],
    } as any;
    const handle = new DshExecutionHandle();
    const executeStream = vi.fn().mockImplementation(async () => {
      setImmediate(() => handle.emit('error', new DshResearchEvidenceError(
        'dsh Agent 工具调用超过上限（3）',
        partialResult,
      )));
      return handle;
    });
    const record = vi.fn().mockResolvedValue(undefined);
    const service = new LegalResearchService({} as any, {
      executeStream,
      getToolCallLimit: () => 3,
    } as any, { record } as any, {} as any);

    const result = await service.aiSearch(
      { query: '员工解除劳动合同需要哪些补偿？' },
      { id: 'legal-1', role: 'legal_bp' as any },
    );

    expect(result).toMatchObject({
      reportId: 'dsh-tool-limit',
      degraded: true,
      warning: { code: 'RESEARCH_TOOL_LIMIT_REACHED' },
      report: {
        resultStatus: 'degraded',
        metrics: { candidateCount: 1, verifiedSourceCount: 0 },
      },
    });
    expect(result.report.title).toContain('候选法规');
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'ai.legal_research.degraded', reasonCode: 'RESEARCH_TOOL_LIMIT_REACHED',
    }));
  });

  it('业务端未读取详情正文时保存安全降级结果，不将未完成模型文本写入对话', async () => {
    const partialResult = {
      text: '未核验模型结论',
      dshSessionId: 'dsh-consult-degraded',
      toolCalls: [{ callId: 's1', name: 'search_laws', arguments: { keyword: '注册资本' } }],
      toolResults: [{
        callId: 's1', name: 'search_laws', isError: false,
        result: { records: [{ recordId: 'law-1', lawName: '中华人民共和国公司法', issuingOrgan: '全国人大常委会', timeliness: '现行有效' }] },
      }],
    } as any;
    const handle = new DshExecutionHandle();
    const router = new ConsultationExecutionRouter({} as any, {
      getToolCallLimit: () => 5,
      executeStream: vi.fn().mockImplementation(async () => {
        setImmediate(() => handle.emit('error', new DshResearchEvidenceError(
          'dsh Agent 命中法规后未读取权威正文',
          partialResult,
        )));
        return handle;
      }),
    } as any, { get: (_key: string, fallback: string) => fallback } as any);

    const stream = await router.execute({
      capability: 'law_search', projectId: 'project-1', runId: 'run-1',
      messages: [{ role: 'user', content: '2024年新公司法认缴期限' }],
    } as any);
    let output = '';
    stream.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exitCode = await new Promise<number>((resolve) => stream.once('close', resolve));

    expect(exitCode).toBe(0);
    expect(output).toContain('已找到候选法规');
    expect(output).not.toContain('未核验模型结论');
    expect(stream.__finalText).toBe(output);
    expect(stream.__researchTrace.report.title).toBe('候选法规已召回，详情正文待读取');
    expect(stream.__researchDegraded).toMatchObject({
      level: 'candidate_only', reasonCode: 'RESEARCH_DETAIL_REQUIRED',
    });
  });
});
