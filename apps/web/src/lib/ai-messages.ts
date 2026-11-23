export const AI_ERROR_MESSAGES: Record<string, string> = {
  invalid_format: "That doesn't look like an Anthropic API key. Keys start with sk-ant-.",
  invalid_key: "Anthropic rejected this key. Check it in the Anthropic Console and try again.",
  unreachable: "Couldn't reach Anthropic to check the key. Try again in a moment.",
  invalid_model: "Choose one of the listed models.",
};

export const AI_SUCCESS_MESSAGES: Record<string, string> = {
  saved: "Key saved. Mail from the last 7 days will be classified over the next few minutes.",
  removed: "Key removed. Classification is paused.",
  model: "Classification model updated. It applies to newly classified threads.",
};
