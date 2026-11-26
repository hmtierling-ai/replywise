import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = join(import.meta.dirname, "../../..");

// Every package and app that talks to mail providers.
const ROOTS = [
  join(import.meta.dirname, "."),
  join(import.meta.dirname, "../../mailbox/src"),
  join(import.meta.dirname, "../../sync/src"),
  join(import.meta.dirname, "../../ai/src"),
  join(import.meta.dirname, "../../../apps/worker/src"),
].filter((dir) => existsSync(dir));

/** Spec M6 §2.3: the only file that may contain Gmail's send-draft URL. */
const SEND_MODULE = "packages/mail/src/gmail-send.ts";
/** Spec M6 §2.3: the only file that may import the send client. */
const SEND_IMPORTER = "apps/worker/src/jobs/send-draft.ts";
const SEND_URL_PATH = "drafts/send";

// Spec §8 + M6 §2.3: no other send capability anywhere.
const FORBIDDEN = [
  /sendMail/i,
  /\/send(?![\w-])/i,
  /messages\.send/i,
  /drafts\/send/i,
  /mail\.send/i,
  /drafts\.send/i,
  /\/(reply|replyAll|forward)\b/i,
];

const posix = (file: string) => relative(REPO, file).split(sep).join("/");

function sourceFiles(dir: string, extensions: string[]): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter(
      (file) =>
        extensions.some((ext) => file.endsWith(ext)) &&
        !/\.test\.tsx?$/.test(file) &&
        !file.includes("node_modules"),
    )
    .map((file) => join(dir, file));
}

/** Every `src` tree under apps/ and packages/. */
function allSourceDirs(): string[] {
  return ["apps", "packages"].flatMap((top) =>
    readdirSync(join(REPO, top))
      .map((name) => join(REPO, top, name, "src"))
      .filter((dir) => existsSync(dir)),
  );
}

describe("no-send guard", () => {
  it("blocks reply/forward endpoints but allows createReply drafts", () => {
    const reply = FORBIDDEN[FORBIDDEN.length - 1] as RegExp;
    expect(reply.test("/me/messages/x/reply")).toBe(true);
    expect(reply.test("/me/messages/x/createReply")).toBe(false);
  });

  it("blocks every /send endpoint but not module paths that start with send-", () => {
    const send = FORBIDDEN[1] as RegExp;
    expect(send.test("users/me/messages/send")).toBe(true);
    expect(send.test("users/me/drafts/send?x=1")).toBe(true);
    expect(send.test("/me/send")).toBe(true);
    expect(send.test('from "./jobs/send-draft"')).toBe(false);
  });

  it("finds no send endpoints outside the one allowlisted Gmail send module", () => {
    const sources = ROOTS.flatMap((dir) => sourceFiles(dir, [".ts"]));
    expect(sources.length).toBeGreaterThan(10);
    const offenders = sources.flatMap((file) => {
      let text = readFileSync(file, "utf8");
      // The allowlist covers exactly the drafts/send path in exactly one file.
      if (posix(file) === SEND_MODULE) text = text.replaceAll(SEND_URL_PATH, "");
      return FORBIDDEN.filter((pattern) => pattern.test(text)).map((p) => `${posix(file)}: ${p}`);
    });
    expect(offenders).toEqual([]);
    expect(readFileSync(join(REPO, SEND_MODULE), "utf8")).toContain(SEND_URL_PATH);
  });

  it("lets only the worker send job create the Gmail send client", () => {
    const files = allSourceDirs().flatMap((dir) => sourceFiles(dir, [".ts", ".tsx"]));
    const users = files
      .filter((file) => readFileSync(file, "utf8").includes("createGmailSendApi"))
      .map(posix)
      .sort();
    expect(users).toEqual([SEND_IMPORTER, SEND_MODULE].sort());
    expect(readFileSync(join(REPO, SEND_IMPORTER), "utf8")).toContain(
      'from "@replywise/mail/gmail-send"',
    );
    // Anyone else may reference the module for types only.
    const valueRefs = files
      .filter((file) => posix(file) !== SEND_IMPORTER)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => /gmail-send["']/.test(line) && !/^\s*(export|import) type\b/.test(line))
          .map((line) => `${posix(file)}: ${line.trim()}`),
      );
    expect(valueRefs).toEqual([]);
  });

  it("keeps every send endpoint out of the web app", () => {
    const patterns = [
      /sendMail/i,
      /messages\/send/i,
      /drafts\/send/i,
      /messages\.send/i,
      /drafts\.send/i,
    ];
    const offenders = sourceFiles(join(REPO, "apps/web/src"), [".ts", ".tsx"]).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return patterns.filter((p) => p.test(text)).map((p) => `${posix(file)}: ${p}`);
    });
    expect(offenders).toEqual([]);
  });
});
