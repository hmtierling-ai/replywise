/** Associated-data strings bind each ciphertext to the row and purpose it belongs to. */
export const aad = {
  aiCredential: (userId: string, provider: string) => `ai_credential:${userId}:${provider}`,
  mailTokens: (mailAccountId: string) => `mail_tokens:${mailAccountId}`,
  messageBody: (messageId: string) => `message_body:${messageId}`,
  replyDraft: (draftId: string) => `reply_draft:${draftId}`,
  oauthVerifier: (stateHash: string) => `oauth_verifier:${stateHash}`,
} as const;
