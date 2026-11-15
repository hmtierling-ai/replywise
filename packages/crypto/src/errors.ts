export class DecryptionError extends Error {
  constructor(message = "Unable to decrypt value") {
    super(message);
    this.name = "DecryptionError";
  }
}
