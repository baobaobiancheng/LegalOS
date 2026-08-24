import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DshService } from '../../../common/services/dsh.service';
import { ConsultationChatService, ChatMessage } from '../../../common/services/consultation-chat.service';
import { ConsultationCapability, isResearchCapability } from '../domain/consultation-capability';
import { buildResearchTrace } from './research-trace';

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
    handle.on('tool_call', () => {
      thinking.write(input.capability === 'law_search' ? '\n已生成法规关键词，正在查询…' : '\n已生成法律问题，正在查询案例库…');
    });
    handle.on('text', (delta) => stdout.write(delta));
    handle.on('done', (result) => {
      stream.__finalText = result.text;
      stream.__researchTrace = buildResearchTrace(input.capability as Exclude<ConsultationCapability, 'general'>, result);
      if (result.text) stdout.write(result.text);
      stdout.end();
      thinking.end();
      emitter.emit('close', result.text.trim() ? 0 : 1);
    });
    handle.on('cancelled', () => {
      stream.__cancelled = true;
      stdout.end();
      thinking.end();
      emitter.emit('close', 1);
    });
    handle.on('error', (error) => {
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
    ? `先判断任务是法条定位、法规定位还是法律问题。本轮必须先使用 search_laws、search_laws_advanced、search_laws_semantic 中至少一种工具召回候选，并按需交叉核对；有命中时必须对最终采用的少量候选调用 get_law_detail，把语义结果的 articleNumber 传为 articleHint，或把待核验问题传为 query，从完整法规中定位目标条文。只有详情正文才算已核验条文。最终报告必须包含：检索结论、相关条文原文、AI分析、适用边界、来源。每条原文单独一行，严格使用“> [法规原文｜ID:32位ID｜条文:第八十七条] 工具返回的逐字原文”格式，不得改写、拼接或补写原文。每个来源按“法规名称｜ID: 32位ID”标注。不得引用未读取详情的法规 ID。若全部检索为零结果，必须以“未检索到可核验来源”开头，不得生成法规结论。`
    : '必须调用 search_similar_cases。只能引用工具真实返回的案例，不得虚构案号、法院或公开链接。';
  return `你是企业法律检索 Agent。先理解对话，再自主规划并按需迭代调用本轮开放的受控工具，然后基于结果回答。\n${sourceRule}\n本轮最多调用工具 ${toolCallLimit} 次；获得足以回答的有效证据后必须停止检索。\n若零结果，仍可给一般分析，但必须在开头醒目标明“未检索到可核验来源”。引用来源时只使用工具返回的信息。不要泄露内部推理过程。\n\n【对话上下文】\n${history}`;
}

export function classifyResearchError(error: Error): string {
  const text = error.message.toLowerCase();
  if (text.includes('quota') || text.includes('额度')) return 'RESEARCH_QUOTA_EXHAUSTED';
  if (text.includes('timeout') || text.includes('超时')) return 'RESEARCH_TIMEOUT';
  if (text.includes('未产生必需工具结果')
    || text.includes('未产生成功的法规检索结果')
    || text.includes('命中法规后未读取权威正文')) return 'RESEARCH_TOOL_REQUIRED';
  if (text.includes('未引用已核验法规')
    || text.includes('未提供可核验的法规原文引用')
    || text.includes('引用了未核验法规')
    || text.includes('原文引用了未核验法规')
    || text.includes('法规原文与权威详情不匹配')
    || text.includes('读取了非候选法规')
    || text.includes('零结果时未声明')) return 'RESEARCH_EVIDENCE_INVALID';
  return 'RESEARCH_UNAVAILABLE';
}

export function publicResearchError(code: string): string {
  if (code === 'RESEARCH_QUOTA_EXHAUSTED') return '案例库额度暂不可用，本次未生成检索结论';
  if (code === 'RESEARCH_TIMEOUT') return '法律检索超时，请重试或改选通用咨询';
  if (code === 'RESEARCH_TOOL_REQUIRED') return '未完成必需的法律检索或正文核验，本次回答未保存';
  if (code === 'RESEARCH_EVIDENCE_INVALID') return '法规证据核验未通过，本次回答未保存，请重试或调整问题';
  return '法律检索暂不可用，本次未切换为通用咨询';
}
