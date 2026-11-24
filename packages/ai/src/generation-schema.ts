import { z } from "zod";
import { AiOutputError } from "./errors";

export const SummaryOutputSchema = z.object({ summary: z.string() });
export const DraftOutputSchema = z.object({ body: z.string() });
export const MAX_DRAFT_CHARS = 20_000;

export function normalizeSummary(output: z.infer<typeof SummaryOutputSchema>): {
  summary: string;
} {
  const summary = output.summary.trim();
  if (!summary) throw new AiOutputError();
  return { summary: summary.slice(0, 4_000) };
}

export function normalizeDraft(output: z.infer<typeof DraftOutputSchema>): { body: string } {
  const body = output.body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (!body) throw new AiOutputError();
  return { body: body.slice(0, MAX_DRAFT_CHARS) };
}
