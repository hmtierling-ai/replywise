import { describe, expect, it } from "vitest";
import { fakeMessage } from "./testing";
import { summarizeThread } from "./thread-summary";

describe("summarizeThread", () => {
  it("summarises subject, snippet, participants, unread and labels", () => {
    const summary = summarizeThread({
      providerThreadId: "t1",
      messages: [
        fakeMessage({
          providerMessageId: "m2",
          sentAt: new Date("2026-11-02T00:00:00Z"),
          subject: "Re: Plans",
          snippet: "Sounds good",
          from: { name: "Me", address: "me@gmail.com" },
          to: [{ name: "Ada", address: "ada@x.com" }],
          labelIds: ["SENT"],
        }),
        fakeMessage({
          providerMessageId: "m1",
          sentAt: new Date("2026-11-01T00:00:00Z"),
          subject: "Plans",
          snippet: "Shall we?",
          from: { name: "Ada", address: "ada@x.com" },
          to: [{ name: null, address: "me@gmail.com" }],
          cc: [{ name: "Bob", address: "bob@y.com" }],
          labelIds: ["INBOX", "UNREAD"],
        }),
      ],
    });
    expect(summary).toEqual({
      providerThreadId: "t1",
      subject: "Plans",
      snippet: "Sounds good",
      participants: [
        { name: "Ada", address: "ada@x.com" },
        { name: null, address: "me@gmail.com" },
        { name: "Bob", address: "bob@y.com" },
      ],
      lastMessageAt: new Date("2026-11-02T00:00:00Z"),
      messageCount: 2,
      isUnread: true,
      providerLabels: ["INBOX", "SENT", "UNREAD"],
    });
  });
});
