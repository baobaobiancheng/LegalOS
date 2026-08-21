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
    ? '必须调用 search_laws。法规结果只有元数据，不得声称已核验具体条文，不得编造法条号。'
    : '必须调用 search_similar_cases。只能引用工具真实返回的案例，不得虚构案号、法院或公开链接。';
  return `你是企业法律检索 Agent。先理解对话，再自主提炼检索词并按需迭代调用唯一可用工具，然后基于结果回答。\n${sourceRule}\n本轮最多调用检索工具 ${toolCallLimit} 次；获得足以回答的有效结果后必须停止检索。\n若零结果，仍可给一般分析，但必须在开头醒目标明“未检索到可核验来源”。引用来源时只使用工具返回的信息。不要泄露内部推理过程。\n\n【对话上下文】\n${history}`;
}

function classifyResearchError(error: Error): string {
  const text = error.message.toLowerCase();
  if (text.includes('quota') || text.includes('额度')) return 'RESEARCH_QUOTA_EXHAUSTED';
  if (text.includes('timeout') || text.includes('超时')) return 'RESEARCH_TIMEOUT';
  if (text.includes('未产生必需工具结果')) return 'RESEARCH_TOOL_REQUIRED';
  return 'RESEARCH_UNAVAILABLE';
}

function publicResearchError(code: string): string {
  if (code === 'RESEARCH_QUOTA_EXHAUSTED') return '案例库额度暂不可用，本次未生成检索结论';
  if (code === 'RESEARCH_TIMEOUT') return '法律检索超时，请重试或改选通用咨询';
  return '法律检索暂不可用，本次未切换为通用咨询';
}
