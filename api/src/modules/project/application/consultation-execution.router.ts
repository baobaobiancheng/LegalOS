import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DshService, partialResearchResult } from '../../../common/services/dsh.service';
import { ConsultationChatService, ChatMessage } from '../../../common/services/consultation-chat.service';
import { ConsultationCapability, isResearchCapability } from '../domain/consultation-capability';
import { buildResearchTrace } from './research-trace';
import {
  AI_LAW_REPORT_OUTPUT_RULE,
  buildAiLawResearchFallback,
  parseAiLawResearchReport,
} from '../../../common/services/ai-law-research-report';
import {
  DSH_LAW_BATCH_DETAIL_TOOL,
  DSH_LAW_DETAIL_TOOL,
  DSH_LAW_SEARCH_TOOL,
  DSH_LAW_ADVANCED_SEARCH_TOOL,
  DSH_LAW_SEMANTIC_SEARCH_TOOL,
} from '../../../common/services/dsh-agent.types';

interface ExecuteInput {
  capability: ConsultationCapability;
  messages: ChatMessage[];
  projectId: string;
  runId: string;
  signal?: AbortSignal;
  resumeDshSessionId?: string;
}

/** 唯一执行器分流点：通用咨询保留公司网关；检索咨询使用 dsh 原生工具循环。 */
@Injectable()
export class ConsultationExecutionRouter {
  constructor(
    private readonly chat: ConsultationChatService,
    private readonly dsh: DshService,
    private readonly config: ConfigService,
  ) {}

  async execute(input: ExecuteInput): Promise<any> {
    if (!isResearchCapability(input.capability)) {
      return this.chat.stream(input.messages, {
        maxTokens: Number.parseInt(String(this.config.get('CONSULT_P2_OUTPUT_TOKENS', '6000')), 10) || 6000,
        timeout: Number.parseInt(String(this.config.get('CONSULT_CHAT_TIMEOUT_MS', '600000')), 10) || 600_000,
        signal: input.signal,
        runId: input.runId,
        projectId: input.projectId,
      });
    }

    const emitter = new EventEmitter();
    const stdout = new PassThrough();
    const thinking = new PassThrough();
    const stream: any = Object.assign(emitter, { stdout, thinking, __runId: input.runId });
    const fallbackQuery = [...input.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const finishWithFallback = (result: NonNullable<ReturnType<typeof partialResearchResult>>, error: Error): boolean => {
      if (input.capability !== 'law_search') return false;
      const reasonCode = classifyResearchError(error);
      const fallback = buildAiLawResearchFallback(fallbackQuery, result, reasonCode);
      if (!fallback) return false;
      stream.__finalText = fallback.answer;
      stream.__researchTrace = buildResearchTrace('law_search', result, fallback.report);
      stream.__researchDegraded = { level: fallback.level, reasonCode };
      thinking.write('\nAI 结论未通过核验，已保留可安全展示的检索结果。');
      stdout.write(fallback.answer);
      stdout.end();
      thinking.end();
      emitter.emit('close', 0);
      return true;
    };
    const prompt = buildResearchPrompt(
      input.capability,
      input.messages,
      Boolean(input.resumeDshSessionId),
      this.dsh.getToolCallLimit(),
    );
    const handle = await this.dsh.executeStream(prompt, {
      sessionId: input.projectId,
      resumeDshSessionId: input.resumeDshSessionId,
      researchCapability: input.capability,
      requireResearchTool: true,
      timeout: Number.parseInt(String(this.config.get('CONSULT_RESEARCH_TIMEOUT_MS', '180000')), 10) || 180_000,
      signal: input.signal,
    });

    thinking.write(input.capability === 'law_search' ? '正在分析问题并检索国内法规…' : '正在分析问题并检索相似案例…');
    handle.on('tool_call', (call) => {
      if (input.capability !== 'law_search') {
        thinking.write('\n已生成法律问题，正在查询案例库…');
        return;
      }
      if ([DSH_LAW_SEARCH_TOOL, DSH_LAW_ADVANCED_SEARCH_TOOL, DSH_LAW_SEMANTIC_SEARCH_TOOL].includes(call.name as any)) {
        thinking.write('\n已确定检索范围，正在召回候选法规…');
      } else if ([DSH_LAW_DETAIL_TOOL, DSH_LAW_BATCH_DETAIL_TOOL].includes(call.name as any)) {
        thinking.write('\n已获得候选法规，正在核验权威正文…');
      }
    });
    handle.on('text', (delta) => stdout.write(delta));
    handle.on('done', (result) => {
      try {
        const parsed = input.capability === 'law_search'
          ? parseAiLawResearchReport(result.text, result.toolResults)
          : null;
        const finalText = parsed?.answer ?? result.text;
        stream.__finalText = finalText;
        stream.__researchTrace = buildResearchTrace(
          input.capability as Exclude<ConsultationCapability, 'general'>,
          result,
          parsed?.report,
        );
        if (finalText) stdout.write(finalText);
        stdout.end();
        thinking.end();
        emitter.emit('close', finalText.trim() ? 0 : 1);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (finishWithFallback(result, failure)) return;
        stream.__errorCode = classifyResearchError(failure);
        stream.__errorMessage = publicResearchError(stream.__errorCode);
        stdout.end();
        thinking.end();
        emitter.emit('close', 1);
      }
    });
    handle.on('cancelled', () => {
      stream.__cancelled = true;
      stdout.end();
      thinking.end();
      emitter.emit('close', 1);
    });
    handle.on('error', (error) => {
      const result = partialResearchResult(error);
      if (result && finishWithFallback(result, error)) return;
      stream.__errorCode = classifyResearchError(error);
      stream.__errorMessage = publicResearchError(stream.__errorCode);
      stdout.end();
      thinking.end();
      emitter.emit('close', 1);
    });
    return stream;
  }
}

function buildResearchPrompt(
  capability: Exclude<ConsultationCapability, 'general'>,
  messages: ChatMessage[],
  resumed: boolean,
  toolCallLimit: number,
): string {
  const selectedMessages = resumed
    ? [...messages].reverse().filter((message) => message.role === 'user').slice(0, 1).reverse()
    : messages;
  const history = selectedMessages.map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
  const sourceRule = capability === 'law_search'
    ? `先判断任务是法条定位、法规定位还是法律问题。本轮必须先使用 search_laws、search_laws_advanced、search_laws_semantic 中至少一种工具召回候选；最多使用两次召回以覆盖不同规范层级。如需直接引用法规原文，优先只调用一次 get_law_details 批量读取最多10部最相关法规；仅在单条精确定位时使用 get_law_detail。若全部检索为零结果，必须明确“未检索到可核验来源”，不得生成确定性法规结论。${AI_LAW_REPORT_OUTPUT_RULE}`
    : '必须调用 search_similar_cases。只能引用工具真实返回的案例，不得虚构案号、法院或公开链接。';
  return `你是企业法律检索 Agent。先理解对话，再自主规划并按需迭代调用本轮开放的受控工具，然后基于结果回答。\n${sourceRule}\n本轮最多调用工具 ${toolCallLimit} 次；获得足以回答的有效证据后必须停止检索。\n若零结果，仍可给一般分析，但必须在开头醒目标明“未检索到可核验来源”。引用来源时只使用工具返回的信息。不要泄露内部推理过程。\n\n【对话上下文】\n${history}`;
}

export function classifyResearchError(error: Error): string {
  const text = error.message.toLowerCase();
  if (text.includes('quota') || text.includes('额度')) return 'RESEARCH_QUOTA_EXHAUSTED';
  if (text.includes('timeout') || text.includes('超时')) return 'RESEARCH_TIMEOUT';
  if (text.includes('工具调用超过上限')) return 'RESEARCH_TOOL_LIMIT_REACHED';
  if (text.includes('白名单外工具')) return 'RESEARCH_TOOL_NOT_ALLOWED';
  if (text.includes('未产生必需工具结果')) return 'RESEARCH_CASE_SEARCH_REQUIRED';
  if (text.includes('未产生成功的法规检索结果')) return 'RESEARCH_SEARCH_REQUIRED';
  if (text.includes('命中法规后未读取权威正文')) return 'RESEARCH_DETAIL_REQUIRED';
  if (text.includes('读取了非候选法规')) return 'RESEARCH_DETAIL_OUTSIDE_CANDIDATES';
  if (text.includes('最终回答未引用已核验法规')) return 'RESEARCH_CITATION_MISSING';
  if (text.includes('原文引用了未核验法规')) return 'RESEARCH_QUOTE_UNVERIFIED';
  if (text.includes('引用了未核验法规')) return 'RESEARCH_CITATION_UNVERIFIED';
  if (text.includes('最终回答未提供可核验的法规原文引用')) return 'RESEARCH_QUOTE_MISSING';
  if (text.includes('引用不是法规正文中的连续原文')) return 'RESEARCH_QUOTE_MISMATCH';
  if (text.includes('法规原文与权威详情不匹配')) return 'RESEARCH_QUOTE_MISMATCH';
  if (text.includes('零结果时未声明')) return 'RESEARCH_EMPTY_UNDECLARED';
  if (text.includes('ai 搜法报告结构无效')) return 'RESEARCH_REPORT_INVALID';
  return 'RESEARCH_UNAVAILABLE';
}

export function publicResearchError(code: string): string {
  if (code === 'RESEARCH_QUOTA_EXHAUSTED') return '法律数据源额度暂不可用，本次未生成检索结论';
  if (code === 'RESEARCH_TIMEOUT') return '法律检索超时，请重试或改选通用咨询';
  if (code === 'RESEARCH_TOOL_LIMIT_REACHED') return '检索步骤已达本轮上限，仍未完成证据核验。请缩小问题范围后重试';
  if (code === 'RESEARCH_TOOL_NOT_ALLOWED') return '检索执行超出允许范围，已安全终止，本次回答未保存';
  if (code === 'RESEARCH_CASE_SEARCH_REQUIRED') return 'AI 未完成类案检索，本次回答未保存，请重试';
  if (code === 'RESEARCH_SEARCH_REQUIRED') return 'AI 未完成法规召回，本次回答未保存，请重试';
  if (code === 'RESEARCH_DETAIL_REQUIRED') return '已找到候选法规，但未完成权威正文读取，本次回答未保存';
  if (code === 'RESEARCH_DETAIL_OUTSIDE_CANDIDATES') return '读取的法规不属于本轮检索结果，本次回答已拦截';
  if (code === 'RESEARCH_CITATION_MISSING') return '回答缺少已核验的法规来源，本次回答未保存';
  if (code === 'RESEARCH_CITATION_UNVERIFIED') return '回答包含未核验的法规来源，本次回答已拦截';
  if (code === 'RESEARCH_QUOTE_MISSING') return '回答缺少可核验的法条原文，本次回答未保存';
  if (code === 'RESEARCH_QUOTE_UNVERIFIED') return '法条原文对应的法规未完成核验，本次回答已拦截';
  if (code === 'RESEARCH_QUOTE_MISMATCH') return '引用法条与权威正文不一致，本次回答已拦截，请重试';
  if (code === 'RESEARCH_EMPTY_UNDECLARED') return '未检索到法规，且回答未明确提示“无可核验来源”，本次回答已拦截';
  if (code === 'RESEARCH_REPORT_INVALID') return 'AI 搜法报告结构不完整，本次回答未保存，请重试';
  return '法律检索暂不可用，本次未切换为通用咨询';
}

export function publicResearchDegradedWarning(code: string): string {
  if (code === 'RESEARCH_DETAIL_REQUIRED') {
    return '已召回候选法规，但尚未完成权威正文读取；当前仅展示候选清单，不作为正式引用依据';
  }
  if (code === 'RESEARCH_SEARCH_REQUIRED') {
    return '法规召回结果未通过完整核验；当前仅展示系统能够安全保留的检索信息';
  }
  return 'AI 结论未通过法规证据核验，系统已拦截未核验内容；当前仅展示可安全核验的法规信息';
}
