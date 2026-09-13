export const CONSULTATION_CAPABILITIES = ['general', 'law_search', 'similar_case'] as const;

export type ConsultationCapability = (typeof CONSULTATION_CAPABILITIES)[number];

// auto 是入站选择，不能传入实际执行器；运行认领后必须先解析为具体能力。
export const CONSULTATION_CAPABILITY_CHOICES = ['auto', ...CONSULTATION_CAPABILITIES] as const;
export type ConsultationCapabilityChoice = (typeof CONSULTATION_CAPABILITY_CHOICES)[number];

export function normalizeConsultationCapabilityChoice(value: ConsultationCapabilityChoice | undefined): ConsultationCapabilityChoice {
  return value ?? 'auto';
}

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
