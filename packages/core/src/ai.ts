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
