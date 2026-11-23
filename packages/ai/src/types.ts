import type { AiProviderId, EmailAddress } from "@replywise/core";

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/** Per-call context: the key is passed per call and never stored on the provider instance. */
export interface AiContext {
  apiKey: string;
  model: string;
  onUsage(usage: AiUsage): void | Promise<void>;
}

export interface ClassifyMessage {
  from: EmailAddress;
  to: EmailAddress[];
  sentAt: Date;
  isFromUser: boolean;
  /** Plain text, quoted history already stripped. */
  text: string;
  hasAttachments: boolean;
}

export interface ClassifyInput {
  mailboxEmail: string;
  subject: string;
  /** Oldest first. */
  messages: ClassifyMessage[];
}

export interface ClassifyResult {
  urgency: number;
  importance: number;
  needsReply: boolean;
  reasons: string[];
}

export type KeyValidation = { ok: true } | { ok: false; reason: "invalid" | "unreachable" };

export interface AiProvider {
  readonly id: AiProviderId;
  validateKey(apiKey: string): Promise<KeyValidation>;
  classify(ctx: AiContext, input: ClassifyInput): Promise<ClassifyResult>;
}
