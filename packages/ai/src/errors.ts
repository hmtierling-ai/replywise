/** Base class: messages are fixed strings, safe to log (no provider text, no email content). */
export class AiError extends Error {}

export class AiKeyInvalidError extends AiError {
  constructor() {
    super("AI key was rejected by the provider");
    this.name = "AiKeyInvalidError";
  }
}
export class AiRateLimitedError extends AiError {
  constructor() {
    super("AI provider rate limit reached");
    this.name = "AiRateLimitedError";
  }
}
export class AiUnavailableError extends AiError {
  constructor(readonly status: number) {
    super(`AI provider unavailable (${status})`);
    this.name = "AiUnavailableError";
  }
}
export class AiRequestError extends AiError {
  constructor(readonly status: number) {
    super(`AI request rejected (${status})`);
    this.name = "AiRequestError";
  }
}
export class AiRefusalError extends AiError {
  constructor() {
    super("AI model declined the request");
    this.name = "AiRefusalError";
  }
}
export class AiOutputError extends AiError {
  constructor() {
    super("AI output did not match the expected format");
    this.name = "AiOutputError";
  }
}

/** Worth retrying later (rate limits, outages); everything else is permanent for this input. */
export function isRetryableAiError(error: unknown): boolean {
  return error instanceof AiRateLimitedError || error instanceof AiUnavailableError;
}
