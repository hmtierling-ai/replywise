import { z } from "zod";
import type { ClassifyResult } from "./types";

/** Sent as the structured-output schema. Ranges are enforced in normalizeClassifyOutput. */
export const ClassifyOutputSchema = z.object({
  urgency: z.number(),
  importance: z.number(),
  needs_reply: z.boolean(),
  reasons: z.array(z.string()),
});

export type ClassifyOutput = z.infer<typeof ClassifyOutputSchema>;

/** Non-finite scores (NaN, ±Infinity) fall back to the lowest score rather than leaking through. */
const clampScore = (n: number) =>
  Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 1;

export function normalizeClassifyOutput(output: ClassifyOutput): ClassifyResult {
  const reasons = output.reasons
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && r.length <= 280)
    .slice(0, 3);
  return {
    urgency: clampScore(output.urgency),
    importance: clampScore(output.importance),
    needsReply: output.needs_reply,
    reasons: reasons.length > 0 ? reasons : ["No explanation was provided."],
  };
}
