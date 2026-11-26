import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../client";
import {
  insertMailAccount,
  insertMessage,
  insertThread,
  insertUser,
  resetTestDb,
  setupTestDb,
} from "../testing";
import { searchThreads } from "./search";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await setupTestDb());
});
afterAll(async () => close());
beforeEach(async () => resetTestDb(db));

async function seed() {
  const alice = await insertUser(db);
  const bob = await insertUser(db);
  const box = await insertMailAccount(db, alice.id);
  const bobBox = await insertMailAccount(db, bob.id);
  const make = async (
    mailAccountId: string,
    subject: string,
    labels: string[],
    extra: { snippet?: string; name?: string; day: number },
  ) => {
    const thread = await insertThread(db, mailAccountId, {
      subject,
      snippet: extra.snippet ?? "",
      participants: [{ name: extra.name ?? "Someone", address: "someone@example.com" }],
      providerLabels: labels,
      lastMessageAt: new Date(`2026-11-${String(extra.day).padStart(2, "0")}T00:00:00Z`),
    });
    await insertMessage(db, thread.id, mailAccountId);
    return thread;
  };
  await make(box.id, "Contract to sign", ["INBOX"], { day: 20 });
  await make(box.id, "Weekly sale", ["CATEGORY_PROMOTIONS", "INBOX"], {
    snippet: "Contract prices drop",
    day: 21,
  });
  await make(box.id, "Proposal", ["SENT"], { name: "Ada CONTRACTOR", day: 22 });
  await make(box.id, "Old thing", [], { snippet: "contract archive", day: 19 });
  await make(box.id, "100% done_now", ["INBOX"], { day: 18 });
  await make(bobBox.id, "Bob contract", ["INBOX"], { day: 23 });
  return { alice, bob };
}

describe("searchThreads", () => {
  it("matches subject, snippet and participants case-insensitively, newest first, with locations", async () => {
    const { alice } = await seed();
    const results = await searchThreads(db, alice.id, "contract");
    expect(results.map((r) => [r.subject, r.location])).toEqual([
      ["Proposal", "sent"],
      ["Weekly sale", "other"],
      ["Contract to sign", "inbox"],
      ["Old thing", "archived"],
    ]);
  });

  it("is scoped to the user", async () => {
    const { bob } = await seed();
    expect((await searchThreads(db, bob.id, "contract")).map((r) => r.subject)).toEqual([
      "Bob contract",
    ]);
  });

  it("treats % and _ in the query literally and ignores queries under 2 characters", async () => {
    const { alice } = await seed();
    expect((await searchThreads(db, alice.id, "100%")).map((r) => r.subject)).toEqual([
      "100% done_now",
    ]);
    // Unescaped, "%%" and "n_w" would match everything / "now".
    expect(await searchThreads(db, alice.id, "%%")).toEqual([]);
    expect(await searchThreads(db, alice.id, "n_w")).toEqual([]);
    expect((await searchThreads(db, alice.id, "e_n")).map((r) => r.subject)).toEqual([
      "100% done_now",
    ]);
    expect(await searchThreads(db, alice.id, " c ")).toEqual([]);
  });
});
