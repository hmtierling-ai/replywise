import { describe, expect, it } from "vitest";
import { isMailProviderId, pickReplyTarget, replySubject } from "./mail";

describe("isMailProviderId", () => {
  it("accepts the supported providers only", () => {
    expect(isMailProviderId("gmail")).toBe(true);
    expect(isMailProviderId("outlook")).toBe(true);
    expect(isMailProviderId("yahoo")).toBe(false);
    expect(isMailProviderId("GMAIL")).toBe(false);
    expect(isMailProviderId("")).toBe(false);
  });
});

describe("pickReplyTarget", () => {
  const msgs = [
    { id: "m1", isFromUser: false },
    { id: "m2", isFromUser: true },
    { id: "m3", isFromUser: false },
    { id: "m4", isFromUser: true },
  ];
  it("answers the pinned message when it is not the user's own", () => {
    expect(pickReplyTarget(msgs, "m1")?.id).toBe("m1");
  });
  it("falls back to the newest inbound message", () => {
    expect(pickReplyTarget(msgs, null)?.id).toBe("m3");
    expect(pickReplyTarget(msgs, "m2")?.id).toBe("m3");
    expect(pickReplyTarget(msgs, "gone")?.id).toBe("m3");
  });
  it("returns null when only the user wrote", () => {
    expect(pickReplyTarget([{ id: "m1", isFromUser: true }], null)).toBeNull();
  });
});

describe("replySubject", () => {
  it("adds Re: once and flattens line breaks", () => {
    expect(replySubject("Contract")).toBe("Re: Contract");
    expect(replySubject("RE: Contract")).toBe("RE: Contract");
    expect(replySubject("A\r\nB ")).toBe("Re: A B");
  });
});
