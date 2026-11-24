export const AI_PROVIDERS = ["anthropic"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const AI_TASKS = ["classify", "summarize", "draft"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const REPLY_TONES = ["professional", "friendly", "concise", "formal", "casual"] as const;
export type ReplyTone = (typeof REPLY_TONES)[number];

/** Defaults only; users choose per-task models in Settings. */
export const DEFAULT_AI_MODELS = {
  classification: "claude-opus-5-5",
  generation: "claude-opus-5-5",
} as const;

/** Models offered for classification, with list prices (USD per million tokens) for estimates. */
export const CLASSIFICATION_MODELS = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "Most capable. Best explanations.",
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
  },
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    description: "Much cheaper. Good for high-volume inboxes.",
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
  },
] as const;

export type ClassificationModelId = (typeof CLASSIFICATION_MODELS)[number]["id"];

export function isClassificationModel(id: string): id is ClassificationModelId {
  return CLASSIFICATION_MODELS.some((m) => m.id === id);
}

export const REPLY_TONE_META: Readonly<Record<ReplyTone, { label: string; description: string }>> =
  {
    professional: { label: "Professional", description: "Clear, courteous and to the point." },
    friendly: { label: "Friendly", description: "Warm and personable." },
    concise: { label: "Concise", description: "As short as possible while complete." },
    formal: { label: "Formal", description: "Polished and respectful; no contractions." },
    casual: { label: "Casual", description: "Relaxed and conversational." },
  };

/** Models offered for any AI task (same catalog as classification). */
export const AI_MODELS = CLASSIFICATION_MODELS;
export const isAiModel = isClassificationModel;

/** Approximate USD cost of a usage record; null for models without a known price. */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number },
): number | null {
  const price = CLASSIFICATION_MODELS.find((m) => m.id === model);
  if (!price) return null;
  return (
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cacheReadTokens * price.cacheReadPerMTok) /
    1_000_000
  );
}
