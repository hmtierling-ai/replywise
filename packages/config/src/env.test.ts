import { describe, expect, it } from "vitest";
import { EnvValidationError, parseEnv, webEnvSchema, workerEnvSchema } from "./env";

const KEK = `v1:${Buffer.alloc(32, 7).toString("base64")}`;
const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  LOCAL_KEKS: KEK,
};

describe("parseEnv", () => {
  it("parses a valid worker environment and applies defaults", () => {
    const env = parseEnv(workerEnvSchema, base);
    expect(env).toMatchObject({ ...base, NODE_ENV: "development", LOG_LEVEL: "info" });
  });

  it("treats empty strings as unset so optional keys stay optional", () => {
    const env = parseEnv(webEnvSchema, {
      ...base,
      APP_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "x".repeat(32),
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    });
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it("lists invalid keys without leaking their values", () => {
    const secretLooking = "postgres-password-should-not-leak";
    let caught: unknown;
    try {
      parseEnv(workerEnvSchema, { ...base, DATABASE_URL: secretLooking, REDIS_URL: undefined });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const error = caught as EnvValidationError;
    expect(error.invalidKeys).toEqual(["DATABASE_URL", "REDIS_URL"]);
    expect(error.message).not.toContain(secretLooking);
  });

  it("requires a 32+ character auth secret for the web app", () => {
    expect(() =>
      parseEnv(webEnvSchema, {
        ...base,
        APP_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "short",
      }),
    ).toThrow(EnvValidationError);
  });

  it("rejects malformed LOCAL_KEKS", () => {
    expect(() => parseEnv(workerEnvSchema, { ...base, LOCAL_KEKS: "not-a-key" })).toThrow(
      EnvValidationError,
    );
  });

  it("accepts optional mailbox OAuth credentials", () => {
    const env = parseEnv(workerEnvSchema, {
      ...base,
      GMAIL_CLIENT_ID: "gmail-id",
      GMAIL_CLIENT_SECRET: "gmail-secret",
      OUTLOOK_CLIENT_ID: "",
    });
    expect(env.GMAIL_CLIENT_ID).toBe("gmail-id");
    expect(env.GMAIL_CLIENT_SECRET).toBe("gmail-secret");
    expect(env.OUTLOOK_CLIENT_ID).toBeUndefined();
  });
});
