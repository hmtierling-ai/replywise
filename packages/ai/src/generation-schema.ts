import { z } from "zod";
import { AiOutputError } from "./errors";

export const SummaryOutputSchema = z.object({ summary: z.string() });
export const DraftOutputSchema = z.object({ body: z.string() });
export const MAX_SUMMARY_CHARS = 4_000;
export const MAX_DRAFT_CHARS = 20_000;

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export function normalizeSummary(output: z.infer<typeof SummaryOutputSchema>): {
  summary: string;
} {
  const summary = cut(output.summary, MAX_SUMMARY_CHARS).trim();
  if (!summary) throw new AiOutputError();
  return { summary };
}

export function normalizeDraft(output: z.infer<typeof DraftOutputSchema>): { body: string } {
  const body = cut(
    output.body
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n"),
    MAX_DRAFT_CHARS,
  ).trim();
  if (!body) throw new AiOutputError();
  return { body };
}
