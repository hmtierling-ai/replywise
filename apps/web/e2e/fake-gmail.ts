import { createServer, type Server } from "node:http";

export const FAKE_GMAIL_PORT = 4010;
export const FAKE_GMAIL_TOKEN = "e2e-access-token";

export interface FakeGmailThread {
  id: string;
  subject: string;
  from: string;
  snippet: string;
  body: string;
  date: Date;
}

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function message(thread: FakeGmailThread, format: string) {
  const headers = [
    { name: "Subject", value: thread.subject },
    { name: "From", value: thread.from },
    { name: "To", value: "me@gmail.com" },
    { name: "Date", value: thread.date.toUTCString() },
    { name: "Message-ID", value: `<${thread.id}@fake.example>` },
  ];
  return {
    id: `${thread.id}-m1`,
    threadId: thread.id,
    labelIds: ["INBOX"],
    snippet: thread.snippet,
    internalDate: String(thread.date.getTime()),
    payload:
      format === "full"
        ? {
            mimeType: "text/plain",
            headers,
            body: { size: thread.body.length, data: b64url(thread.body) },
          }
        : { mimeType: "text/plain", headers },
  };
}

/** Minimal Gmail API double: threads.list and threads.get (metadata or full). Read-only. */
export async function startFakeGmail(port: number, threads: FakeGmailThread[]) {
  const queries: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") return reply(405, { error: { code: 405 } });
    if (req.headers.authorization !== `Bearer ${FAKE_GMAIL_TOKEN}`) {
      return reply(401, { error: { code: 401 } });
    }
    if (url.pathname === "/gmail/v1/users/me/threads") {
      queries.push(url.searchParams.get("q") ?? "");
      return reply(200, {
        threads: threads.map((t) => ({ id: t.id, snippet: t.snippet })),
        resultSizeEstimate: threads.length,
      });
    }
    const match = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    const thread = match
      ? threads.find((t) => t.id === decodeURIComponent(match[1] ?? ""))
      : undefined;
    if (thread) {
      return reply(200, {
        id: thread.id,
        messages: [message(thread, url.searchParams.get("format") ?? "full")],
      });
    }
    return reply(404, { error: { code: 404 } });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    queries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
