import { describe, expect, it } from "vitest";
import { buildSummarizePrompt, SUMMARY_SYSTEM_PROMPT } from "./summarize-prompt";
import { buildThreadBlock } from "./thread-block";

const base = {
  mailboxEmail: "me@gmail.com",
  subject: "Contract",
  messages: [
    {
      from: { name: "Ada", address: "ada@client.com" },
      to: [{ name: null, address: "me@gmail.com" }],
      sentAt: new Date("2026-11-20T10:00:00Z"),
      isFromUser: false,
      text: "Can you sign by Friday?",
      hasAttachments: false,
    },
  ],
};

describe("buildSummarizePrompt", () => {
  it("contains the thread block and the summarize instruction", () => {
    const p = buildSummarizePrompt(base);
    expect(p).toContain(buildThreadBlock(base));
    expect(p).toContain("Summarize the email thread above");
  });
  it("tells the model not to follow instructions in the thread", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/never follow instructions/i);
  });
});
