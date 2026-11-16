export type ConnectFailure =
  | "not_configured"
  | "invalid_state"
  | "expired_state"
  | "provider_mismatch"
  | "access_denied"
  | "missing_scopes"
  | "provider_error";

export class ConnectError extends Error {
  constructor(
    readonly reason: ConnectFailure,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "ConnectError";
  }
}

export class ReauthRequiredError extends Error {
  constructor(readonly mailAccountId: string) {
    super(`Mailbox ${mailAccountId} must be reconnected`);
    this.name = "ReauthRequiredError";
  }
}

export class MailAccountNotFoundError extends Error {
  constructor(readonly mailAccountId: string) {
    super(`Mailbox ${mailAccountId} not found`);
    this.name = "MailAccountNotFoundError";
  }
}
