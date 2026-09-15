import { expect, test } from '@playwright/test';
import type { AiLawResearchReportV1 } from '../src/types';

test('完整报告直接展示；追问断流或缺失报告时保留上轮并同步会话', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/auth/refresh', route => route.fulfill({ json: { accessToken: 'fixture-token' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { id: 'u1', role: 'legal_bp', displayName: '测试法务' } }));
  const report: AiLawResearchReportV1 = {
    schemaVersion: 1, resultStatus: 'complete', query: '测试问题', title: '测试报告', scope: '测试范围',
    summary: '完整报告的总结', answer: '完整报告的正文', sections: [], sources: [], limitations: [],
    understanding: { queryType: 'legal_issue', analysis: '分析测试问题', retrievalPlan: '测试检索', knownFacts: [], legalIssues: [], factChanges: { added: [], corrected: [], removed: [] } },
    generatedAt: '2026-09-15T00:00:00Z', metrics: { candidateCount: 0, verifiedSourceCount: 0, citedSourceCount: 0 },
  };
  let attempts = 0;
  let synchronizations = 0;
  await page.route('**/api/legal-research/ai/conversations/c1', route => {
    synchronizations++;
    return route.fulfill({ json: {
      conversationId: 'c1', contextVersion: 1, lastTurnId: 'r1', activeRunId: null,
      turns: [{ turnId: 'r1', status: 'succeeded', question: '测试问题', operation: 'new', reportId: 'd1', report, createdAt: report.generatedAt }],
    } });
  });
  await page.route('**/api/legal-research/ai/stream', route => {
    attempts++;
    const events: Record<string, unknown>[] = [
      { type: 'research_session', seq: 1, runId: `r${attempts}`, conversationId: 'c1', turnId: `r${attempts}`, contextVersion: attempts, operation: 'new', question: '测试问题' },
    ];
    if (attempts === 1) events.push({ type: 'report_completed', seq: 2, runId: 'r1', conversationId: 'c1', turnId: 'r1', contextVersion: 1, reportId: 'd1', report });
    if (attempts === 3) events.push({ type: 'report_completed', seq: 2, runId: 'r3', conversationId: 'c1', turnId: 'r3', contextVersion: 3, reportId: 'd3' });
    return route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
  });
  await page.goto('/legal/research');
  await page.getByRole('tab', { name: 'AI 搜法', exact: true }).click();
  await page.getByPlaceholder('描述法律问题，例如：我想离婚，进行财产分割').fill('测试问题');
  await page.getByRole('button', { name: '开始 AI 搜法', exact: true }).click();
  await expect(page.getByText('完整报告的总结', { exact: true })).toBeVisible();
  await expect(page.getByText('完整报告的正文', { exact: true })).toBeVisible();
  for (let i = 1; i <= 2; i++) {
    await page.getByPlaceholder('直接输入补充事实或新的法律问题…').fill('补充问题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => synchronizations).toBe(i);
    await expect(page.getByText('完整报告的正文', { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('直接输入补充事实或新的法律问题…')).toBeEnabled();
  }
  expect(attempts).toBe(3);
});
