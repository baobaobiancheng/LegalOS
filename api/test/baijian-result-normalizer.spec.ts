import { describe, expect, it } from 'vitest';
import { BaijianResultNormalizer, classifySupplierError } from '../src/common/baijian/baijian-result.normalizer';
import { BAIJIAN_CASE_SEARCH_TOOL, BAIJIAN_LAW_DETAIL_TOOL, BAIJIAN_LAW_SEARCH_TOOL } from '../src/common/baijian/baijian.types';

const normalizer = new BaijianResultNormalizer();

describe('BaijianResultNormalizer', () => {
  it('标准化法律之星结果并清理标题 HTML', () => {
    const result = normalizer.normalize({
      toolName: BAIJIAN_LAW_SEARCH_TOOL,
      content: [{
        type: 'text',
        text: JSON.stringify({
          code: '200',
          data: {
            count: 2343,
            pageSize: 1,
            totalPage: 2343,
            lawdata: [{
              lawId: 'LAW-1',
              lawName: "中华人民共和国<span style='color:red'>劳动合同</span>法",
              issuingOrgan: '全国人大常委会',
              issuingNo: '主席令第73号',
              releaseYearMonthDate: '2012-12-28',
              implementYearMonthDate: '2013-07-01',
              timeliness: '现行有效',
            }],
          },
        }),
      }],
    });

    expect(result.status).toBe('success_hit');
    expect(result.records[0]).toMatchObject({
      recordId: 'LAW-1',
      lawName: '中华人民共和国劳动合同法',
      source: 'lawstar',
    });
  });

  it('区分成功零命中与供应商错误', () => {
    const empty = normalizer.normalize({
      toolName: BAIJIAN_LAW_SEARCH_TOOL,
      structuredContent: {
        code: 200,
        data: { count: 0, pageSize: 10, totalPage: 0, lawdata: [] },
      },
    });
    expect(empty.status).toBe('success_empty');

    expect(() => normalizer.normalize({
      toolName: BAIJIAN_LAW_SEARCH_TOOL,
      structuredContent: { code: -32029, msg: "You've used today's free quota" },
    })).toThrowError(expect.objectContaining({ code: 'BAIJIAN_QUOTA_EXHAUSTED' }));
  });

  it('标准化 LDH 权威 source_id，拒绝非 HTTPS 来源链接', () => {
    const result = normalizer.normalize({
      toolName: BAIJIAN_CASE_SEARCH_TOOL,
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: '违法解除劳动合同',
          total_hits: 2,
          elapsed_ms: 23,
          hits: [
            {
              source: 'CN/Court', source_id: 'CASE-1', title: '<b>劳动争议案</b>',
              court: '某人民法院', date: '2025-01-01', url: 'https://example.test/case/1', score: 0.91,
            },
            {
              source: 'CN/Court', source_id: 'CASE-2', title: '另一案件',
              url: 'http://unsafe.test/case/2', score: null,
            },
          ],
        }),
      }],
    });

    expect(result.status).toBe('success_hit');
    expect(result.records[0]).toMatchObject({ recordId: 'CASE-1', source: 'ldh', title: '劳动争议案' });
    expect(result.records[1]).toMatchObject({ recordId: 'CASE-2', url: null, score: null });
  });

  it('把 quota、timeout 和 auth 映射为稳定错误码', () => {
    expect(classifySupplierError({ code: -32029, message: 'free quota' }).code).toBe('BAIJIAN_QUOTA_EXHAUSTED');
    expect(classifySupplierError(new Error('request timed out')).code).toBe('BAIJIAN_TIMEOUT');
    expect(classifySupplierError(new Error('HTTP 401 unauthorized')).code).toBe('BAIJIAN_AUTH_FAILED');
  });

  it('把法规详情转换为无 HTML 的目录与正文块', () => {
    const result = normalizer.normalize({
      toolName: BAIJIAN_LAW_DETAIL_TOOL,
      structuredContent: {
        code: 200,
        data: {
          rjs8: 'D6592443DA000EF8D692CE667E947A69',
          lawName: '中华人民共和国劳动合同法',
          tocItem: [{ id: 'section0', text: '<b>第一章 总则</b>', indentLevel: 0, children: [] }],
          lawSourceContent: "<p id='section0' style='text-align:center'><strong>第一章 总则</strong></p><p>　　第一条 &lt;法规正文&gt;</p><script>alert(1)</script>",
        },
      },
    });
    expect(result).toMatchObject({
      toolName: BAIJIAN_LAW_DETAIL_TOOL,
      toc: [{ id: 'section0', text: '第一章 总则' }],
      contentBlocks: [
        { kind: 'heading', text: '第一章 总则' },
        { kind: 'paragraph', text: '第一条 <法规正文>' },
      ],
    });
  });
});
