import { createGmailSendApi } from "@replywise/mail/gmail-send";

/** Replaced by the send job in Task 6. The guard requires this file to be the only importer. */
export const sendClientFor = (accessToken: string) => createGmailSendApi(accessToken);
