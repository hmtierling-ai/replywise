import "server-only";
import { createEncryptor, type Encryptor, LocalKeyProvider } from "@replywise/crypto";
import { getEnv } from "./env";

let encryptor: Encryptor | undefined;

export function getEncryptor(): Encryptor {
  encryptor ??= createEncryptor(LocalKeyProvider.fromEnv(getEnv().LOCAL_KEKS));
  return encryptor;
}
