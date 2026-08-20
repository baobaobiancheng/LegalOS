export const CONSULTATION_CAPABILITIES = ['general', 'law_search', 'similar_case'] as const;

export type ConsultationCapability = (typeof CONSULTATION_CAPABILITIES)[number];

export function normalizeConsultationCapability(value: unknown): ConsultationCapability {
  return CONSULTATION_CAPABILITIES.includes(value as ConsultationCapability)
    ? value as ConsultationCapability
    : 'general';
}

export function isResearchCapability(
  capability: ConsultationCapability,
): capability is Exclude<ConsultationCapability, 'general'> {
  return capability !== 'general';
}
