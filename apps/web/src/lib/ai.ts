import "server-only";
import { type AiProvider, createAnthropicProvider } from "@replywise/ai";

let provider: AiProvider | undefined;

export function getAiProvider(): AiProvider {
  provider ??= createAnthropicProvider();
  return provider;
}
