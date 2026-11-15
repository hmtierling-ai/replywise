/** Holds key-encryption keys (KEKs). Implementations: local (env) and cloud KMS. */
export interface KeyProvider {
  /** Key id used to wrap data keys for new encryptions. */
  readonly currentKeyId: string;
  wrapKey(dataKey: Buffer, keyId: string): Promise<Buffer>;
  /** Must throw DecryptionError when the key id is unknown or the wrapped key is invalid. */
  unwrapKey(wrappedKey: Buffer, keyId: string): Promise<Buffer>;
}
