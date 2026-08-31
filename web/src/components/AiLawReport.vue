<script setup lang="ts">
import { computed } from 'vue'
import type { AiLawResearchReportV1 } from '../types'

const props = withDefaults(defineProps<{
  report: AiLawResearchReportV1
  compact?: boolean
  expandable?: boolean
  anchorPrefix?: string
}>(), {
  compact: false,
  expandable: false,
  anchorPrefix: 'ai-report',
})

const emit = defineEmits<{ toggleFull: [] }>()
const visibleSources = computed(() => props.compact ? props.report.sources.slice(0, 4) : props.report.sources)
type ProcessStatus = 'completed' | 'empty' | 'incomplete' | 'skipped' | 'degraded'
const isDegraded = computed(() => props.report.resultStatus === 'degraded')
const processSteps = computed<Array<{ key: string; label: string; status: ProcessStatus; statusLabel: string }>>(() => [
  { key: 'understand', label: '理解问题', status: 'completed', statusLabel: '已完成' },
  props.report.metrics.candidateCount > 0
    ? { key: 'recall', label: '法规召回', status: 'completed', statusLabel: '已完成' }
    : { key: 'recall', label: '法规召回', status: 'empty', statusLabel: '无结果' },
  props.report.metrics.verifiedSourceCount > 0
    ? { key: 'verify', label: '读取正文', status: 'completed', statusLabel: '已完成' }
    : props.report.metrics.candidateCount > 0
      ? { key: 'verify', label: '读取正文', status: 'incomplete', statusLabel: '未完成' }
      : { key: 'verify', label: '读取正文', status: 'skipped', statusLabel: '已跳过' },
  isDegraded.value
    ? { key: 'answer', label: props.compact ? '生成回答' : '生成报告', status: 'degraded', statusLabel: '已降级' }
    : { key: 'answer', label: props.compact ? '生成回答' : '生成报告', status: 'completed', statusLabel: '已完成' },
])
const overallStatus = computed(() => {
  if (isDegraded.value) return { label: '已生成安全降级结果', tone: 'degraded' }
  if (props.report.metrics.candidateCount === 0) return { label: '未检索到可核验来源', tone: 'empty' }
  if (props.report.metrics.verifiedSourceCount === 0) return { label: '已完成法规召回', tone: 'unverified' }
  return { label: '已完成 AI 搜法', tone: 'complete' }
})
const sourceById = computed(() => new Map(props.report.sources.map(source => [source.recordId.toLowerCase(), source])))

function sourceLabel(id: string) {
  return sourceById.value.get(id.toLowerCase())?.lawName ?? '模型标注来源（未关联详情）'
}

function formatVerifiedAt(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <article :class="['ai-law-report', { compact }]">
    <header :class="['report-status', `status-${overallStatus.tone}`]">
      <div>
        <strong><i />{{ overallStatus.label }}</strong>
        <span>
          已读取 {{ report.metrics.verifiedSourceCount }} 部权威法规正文
          <template v-if="compact"> · 本次引用 {{ report.metrics.citedSourceCount }} 部</template>
        </span>
      </div>
      <button
        v-if="expandable"
        class="full-report-button"
        type="button"
        @click="emit('toggleFull')"
      >
        {{ compact ? '查看完整搜法报告' : '收起完整搜法报告' }}
      </button>
    </header>

    <details
      class="research-process"
      open
    >
      <summary>已完成检索思考</summary>
      <div class="process-grid">
        <div
          v-for="(step, index) in processSteps"
          :key="step.key"
          class="process-step"
        >
          <span class="step-icon">{{ index + 1 }}</span>
          <span><strong>{{ step.label }}</strong><small :class="`step-${step.status}`"><i />{{ step.statusLabel }}</small></span>
        </div>
      </div>
      <div class="process-narrative">
        <section>
          <span>01</span>
          <div>
            <h4>分析法条检索需求</h4>
            <p>{{ report.understanding.analysis }}</p>
          </div>
        </section>
        <section>
          <span>02</span>
          <div>
            <h4>定位与检索</h4>
            <p>{{ report.understanding.retrievalPlan }}</p>
          </div>
        </section>
        <section
          v-if="report.understanding.factChanges.corrected.length || report.understanding.factChanges.added.length || report.understanding.factChanges.removed.length"
          class="fact-change-section"
        >
          <span>修</span>
          <div>
            <h4>本轮事实变化</h4>
            <ul>
              <li
                v-for="item in report.understanding.factChanges.corrected"
                :key="`${item.from}-${item.to}`"
              >
                “{{ item.from }}”已修正为“{{ item.to }}”
              </li>
              <li
                v-for="item in report.understanding.factChanges.added"
                :key="`added-${item}`"
              >
                新增：{{ item }}
              </li>
              <li
                v-for="item in report.understanding.factChanges.removed"
                :key="`removed-${item}`"
              >
                移除：{{ item }}
              </li>
            </ul>
          </div>
        </section>
      </div>
      <div class="context-snapshot">
        <span>当前事实 {{ report.understanding.knownFacts.length }}</span>
        <span>法律争点 {{ report.understanding.legalIssues.length }}</span>
        <small>检索范围：{{ report.scope }}</small>
      </div>
    </details>

    <section
      :id="`${anchorPrefix}-summary`"
      class="report-section summary-section"
    >
      <h2>{{ compact ? '初步结论' : '总结' }}</h2>
      <p>{{ report.summary }}</p>
    </section>

    <section
      :id="`${anchorPrefix}-analysis`"
      class="report-section analysis-section"
    >
      <h2>具体分析</h2>
      <div class="analysis-list">
        <div
          v-for="section in report.sections"
          :id="`${anchorPrefix}-${section.id}`"
          :key="section.id"
          class="analysis-row"
        >
          <h3>{{ section.title }}</h3>
          <div>
            <p>{{ section.content }}</p>
            <div
              v-if="section.sourceIds.length"
              class="citation-list"
            >
              <span
                v-for="sourceId in section.sourceIds"
                :key="sourceId"
              >{{ sourceLabel(sourceId) }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section
      :id="`${anchorPrefix}-sources`"
      class="report-section source-section"
    >
      <h2>权威来源 <span>{{ report.sources.length }}</span></h2>
      <div class="source-list">
        <details
          v-for="(source, index) in visibleSources"
          :key="source.recordId"
          class="source-card"
          :open="!compact && index === 0"
        >
          <summary>
            <span class="source-document">法</span>
            <span class="source-heading">
              <strong>{{ source.lawName }}</strong>
              <small>{{ source.issuingOrgan || '未标注发布机关' }}<template v-if="source.issuingNo"> · {{ source.issuingNo }}</template><template v-if="source.lastVerifiedAt"> · 核验于 {{ formatVerifiedAt(source.lastVerifiedAt) }}</template></small>
            </span>
            <span
              v-if="source.timeliness"
              class="source-validity"
            >{{ source.timeliness }}</span>
          </summary>
          <div
            v-if="source.articles.length"
            class="article-list"
          >
            <div
              v-for="article in source.articles"
              :key="`${source.recordId}-${article.article}`"
            >
              <strong>{{ article.article }}</strong>
              <p>
                {{ article.text }}
                <small>模型标注引文，未做逐字核对</small>
              </p>
            </div>
          </div>
          <p
            v-else
            class="verified-without-quote"
          >
            已读取权威详情正文，本次回答未直接引用该法规条文。
          </p>
        </details>
      </div>
      <button
        v-if="expandable && report.sources.length > 4"
        class="all-sources-button"
        type="button"
        @click="emit('toggleFull')"
      >
        {{ compact ? `查看全部 ${report.sources.length} 部已读取法规` : '收起法规列表' }}
      </button>
    </section>

    <aside
      v-if="!compact && report.limitations.length"
      class="report-limitations"
    >
      <strong>适用边界</strong>
      <ul>
        <li
          v-for="item in report.limitations"
          :key="item"
        >
          {{ item }}
        </li>
      </ul>
    </aside>
  </article>
</template>

<style scoped>
.ai-law-report { color: #172033; font-size: 14px; line-height: 1.72; }
.report-status { display: flex; margin-bottom: 12px; align-items: flex-start; justify-content: space-between; gap: 20px; }
.report-status > div { display: flex; flex-direction: column; gap: 3px; }
.report-status strong { display: inline-flex; align-items: center; gap: 8px; color: #159957; font-size: 14px; }
.report-status strong i { width: 15px; height: 15px; border: 2px solid #1aaa63; border-radius: 50%; }
.report-status strong i::after { display: block; width: 6px; height: 3px; margin: 3px 0 0 3px; border-bottom: 1.5px solid #1aaa63; border-left: 1.5px solid #1aaa63; content: ''; transform: rotate(-45deg); }
.report-status.status-degraded strong,
.report-status.status-unverified strong { color: #a15c08; }
.report-status.status-degraded strong i,
.report-status.status-unverified strong i { border-color: #d98a24; }
.report-status.status-degraded strong i::after,
.report-status.status-unverified strong i::after { border-color: #d98a24; }
.report-status.status-empty strong { color: #64748b; }
.report-status.status-empty strong i { border-color: #94a3b8; }
.report-status.status-empty strong i::after { display: none; }
.report-status span { color: #718096; font-size: 12px; }
.full-report-button { padding: 5px 0; border: 0; background: transparent; color: #0f5fff; font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; }
.research-process { overflow: hidden; margin: 0 0 14px; border: 1px solid #dce4ef; border-radius: 7px; background: #fbfcfe; }
.research-process summary { padding: 10px 14px; color: #27364d; font-weight: 680; cursor: pointer; }
.process-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 8px 18px 6px; gap: 0; }
.process-step { position: relative; display: flex; min-width: 0; align-items: center; gap: 9px; }
.process-step:not(:last-child)::after { position: absolute; top: 16px; right: 16px; left: 64%; height: 1px; background: #b8c5d8; content: ''; }
.step-icon { display: grid; width: 31px; height: 31px; border: 1px solid #b7c5d8; border-radius: 50%; place-items: center; flex: 0 0 auto; color: #263a57; font-size: 12px; font-weight: 700; }
.process-step > span:last-child { display: flex; min-width: 0; flex-direction: column; }
.process-step strong { color: #2a3850; font-size: 12px; }
.process-step small { display: flex; align-items: center; gap: 5px; color: #16a05d; font-size: 11px; }
.process-step small i { width: 7px; height: 7px; border-radius: 50%; background: #18aa61; }
.process-step small.step-empty,
.process-step small.step-skipped { color: #7b8798; }
.process-step small.step-empty i,
.process-step small.step-skipped i { background: #a7b1bf; }
.process-step small.step-incomplete,
.process-step small.step-degraded { color: #aa620b; }
.process-step small.step-incomplete i,
.process-step small.step-degraded i { background: #dc8b27; }
.process-narrative { margin: 8px 18px 12px; overflow: hidden; border-top: 1px solid #e3e9f1; }
.process-narrative section { display: grid; grid-template-columns: 28px minmax(0, 1fr); padding: 12px 0; gap: 10px; }
.process-narrative section + section { border-top: 1px solid #e9edf3; }
.process-narrative section > span { display: grid; width: 24px; height: 24px; border-radius: 5px; place-items: center; background: #edf4ff; color: #0f5fff; font-size: 10px; font-weight: 750; }
.process-narrative h4 { margin: 1px 0 3px; color: #25354d; font-size: 12px; }
.process-narrative p { margin: 0; color: #647189; font-size: 12px; line-height: 1.65; white-space: pre-line; }
.process-narrative ul { margin: 3px 0 0; padding-left: 17px; color: #647189; font-size: 11px; }
.process-narrative .fact-change-section > span { background: #fff3e4; color: #a65c07; }
.context-snapshot { display: flex; margin: 0 18px 12px; align-items: center; flex-wrap: wrap; gap: 6px; }
.context-snapshot span { padding: 2px 7px; border-radius: 4px; background: #eef3f8; color: #596981; font-size: 10px; }
.context-snapshot small { margin-left: auto; color: #768397; font-size: 10px; }
.report-section { scroll-margin-top: 20px; }
.report-section h2 { margin: 14px 0 6px; color: #101827; font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.report-section h2 span { margin-left: 5px; color: #6b7890; font-size: 13px; font-weight: 600; }
.summary-section > p { margin: 0; white-space: pre-line; }
.analysis-list { overflow: hidden; border: 1px solid #e0e6ef; border-radius: 6px; }
.analysis-row { display: grid; grid-template-columns: minmax(120px, 1.2fr) minmax(0, 8.8fr); }
.analysis-row + .analysis-row { border-top: 1px solid #e7ebf2; }
.analysis-row h3 { margin: 0; padding: 10px 12px; border-right: 1px solid #e7ebf2; color: #24334b; font-size: 13px; }
.analysis-row > div { min-width: 0; padding: 9px 12px; }
.analysis-row p { margin: 0; white-space: pre-line; }
.citation-list { display: flex; margin-top: 5px; flex-wrap: wrap; gap: 5px; }
.citation-list span { padding: 2px 7px; border-radius: 4px; background: #edf4ff; color: #0f5fff; font-size: 11px; font-weight: 620; }
.source-list { overflow: hidden; border: 1px solid #dce4ef; border-radius: 7px; }
.source-card + .source-card { border-top: 1px solid #e4eaf2; }
.source-card summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; padding: 9px 12px; align-items: center; gap: 10px; cursor: pointer; list-style: none; }
.source-card summary::-webkit-details-marker { display: none; }
.source-document { display: grid; width: 28px; height: 28px; border-radius: 5px; place-items: center; background: #edf4ff; color: #0f5fff; font-size: 12px; font-weight: 700; }
.source-heading { display: flex; min-width: 0; flex-direction: column; }
.source-heading strong { overflow: hidden; color: #202b3c; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.source-heading small { overflow: hidden; color: #718096; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.source-validity { padding: 2px 7px; border-radius: 4px; background: #ecf9f1; color: #159957; font-size: 10px; font-weight: 650; }
.article-list > div { display: grid; grid-template-columns: minmax(120px, 1.4fr) minmax(0, 8.6fr); border-top: 1px solid #e8edf4; }
.article-list strong { padding: 8px 12px; border-right: 1px solid #e8edf4; color: #394963; font-size: 11px; }
.article-list p { margin: 0; padding: 8px 12px; color: #5d6878; font-size: 11px; }
.article-list p small { display: block; margin-top: 5px; color: #9a6b2f; font-size: 10px; }
.verified-without-quote { margin: 0; padding: 8px 12px; border-top: 1px solid #e8edf4; color: #718096; font-size: 11px; }
.all-sources-button { display: block; margin: 8px auto 0; padding: 4px 10px; border: 0; background: transparent; color: #0f5fff; font: inherit; font-size: 11px; font-weight: 620; cursor: pointer; }
.report-limitations { margin-top: 14px; padding: 11px 13px; border-left: 3px solid #b8c9e7; background: #f7f9fc; color: #5b687b; font-size: 12px; }
.report-limitations strong { color: #26364f; }
.report-limitations ul { margin: 4px 0 0; padding-left: 18px; }
.compact .report-section h2 { font-size: 16px; }
.compact .research-process { margin-bottom: 10px; }

@media (max-width: 860px) {
  .process-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 12px; }
  .process-step::after { display: none; }
  .analysis-row { grid-template-columns: 1fr; }
  .analysis-row h3 { padding-bottom: 2px; border-right: 0; }
  .article-list > div { grid-template-columns: 1fr; }
  .article-list strong { padding-bottom: 2px; border-right: 0; }
}
</style>
