import { describe, expect, it } from "vitest";
import { decodeEncodedWords } from "./encoded-words";

describe("decodeEncodedWords", () => {
  it("decodes base64 (B) encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?w4lsw6huZQ==?=")).toBe("Élène");
  });

  it("decodes quoted-printable (Q) encoded words in other charsets", () => {
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Caf=E9_cr=E8me?=")).toBe("Café crème");
  });

  it("ignores whitespace between adjacent encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?Q?Hello?= =?UTF-8?Q?_World?=")).toBe("Hello World");
  });

  it("keeps surrounding plain text and leaves plain values untouched", () => {
    expect(decodeEncodedWords("Re: =?UTF-8?Q?caf=C3=A9?= tomorrow")).toBe("Re: café tomorrow");
    expect(decodeEncodedWords("Just text")).toBe("Just text");
  });

  it("leaves words with unknown charsets as they are", () => {
    expect(decodeEncodedWords("=?x-unknown?Q?abc?=")).toBe("=?x-unknown?Q?abc?=");
  });
});
