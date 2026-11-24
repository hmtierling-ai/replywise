import { CLASSIFICATION_MODELS, estimateCostUsd } from "@replywise/core";
import { getAiCredentialSummary, getClassificationModel, summarizeAiUsage } from "@replywise/db";
import { connection } from "next/server";
import {
  deleteAiKeyAction,
  saveAiKeyAction,
  setClassificationModelAction,
} from "@/app/(app)/settings/ai/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { WritingSettings } from "./writing-settings";

const STATUS = {
  valid: { label: "Valid", variant: "secondary" },
  invalid: { label: "Rejected", variant: "destructive" },
  unverified: { label: "Unverified", variant: "outline" },
} as const;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const usd = (n: number) => (n < 0.01 ? "< $0.01" : `$${n.toFixed(2)}`);

export async function AiSettings() {
  const user = await requireUser();
  await connection();
  const db = getDb();
  const [credential, model, usage] = await Promise.all([
    getAiCredentialSummary(db, user.id),
    getClassificationModel(db, user.id),
    summarizeAiUsage(db, user.id, new Date(Date.now() - THIRTY_DAYS_MS)),
  ]);

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section aria-labelledby="ai-key-heading" className="flex flex-col gap-3">
        <h2 id="ai-key-heading" className="text-sm font-medium">
          Anthropic API key
        </h2>
        {credential ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono">••••{credential.keyHint}</span>
            <Badge variant={STATUS[credential.status].variant}>
              {STATUS[credential.status].label}
            </Badge>
            <form action={deleteAiKeyAction}>
              <Button type="submit" variant="outline" size="sm">
                Remove key
              </Button>
            </form>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No key yet. Replywise uses your own key; it is encrypted and never shown again.
          </p>
        )}
        <form action={saveAiKeyAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="apiKey">{credential ? "Replace key" : "API key"}</Label>
            <Input
              id="apiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              required
            />
          </div>
          <Button type="submit">Save key</Button>
        </form>
      </section>

      <section
        aria-labelledby="ai-model-heading"
        className="flex flex-col gap-3 border-t border-border pt-6"
      >
        <h2 id="ai-model-heading" className="text-sm font-medium">
          Classification model
        </h2>
        <form action={setClassificationModelAction} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Classification model</legend>
            {CLASSIFICATION_MODELS.map((option) => (
              <label key={option.id} className="flex items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="model"
                  value={option.id}
                  defaultChecked={option.id === model}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div>
            <Button type="submit" variant="outline" size="sm">
              Save model
            </Button>
          </div>
        </form>
      </section>

      <WritingSettings />

      <section
        aria-labelledby="ai-usage-heading"
        className="flex flex-col gap-3 border-t border-border pt-6"
      >
        <h2 id="ai-usage-heading" className="text-sm font-medium">
          Usage, last 30 days
        </h2>
        {usage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI calls yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Task</th>
                <th className="py-1 font-medium">Model</th>
                <th className="py-1 text-right font-medium">Calls</th>
                <th className="py-1 text-right font-medium">Tokens in / out</th>
                <th className="py-1 text-right font-medium">≈ Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((row) => {
                const cost = estimateCostUsd(row.model, row);
                return (
                  <tr key={`${row.task}-${row.model}`} className="border-t border-border">
                    <td className="py-1.5 capitalize">{row.task}</td>
                    <td className="py-1.5">{row.model}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.calls}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {row.inputTokens.toLocaleString("en-US")} /{" "}
                      {row.outputTokens.toLocaleString("en-US")}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {cost === null ? "—" : usd(cost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted-foreground">
          Estimates use list prices; your Anthropic bill is authoritative.
        </p>
      </section>
    </div>
  );
}

export function AiSettingsSkeleton() {
  return (
    <div className="mt-8 flex flex-col gap-3" aria-hidden>
      <div className="h-24 animate-pulse rounded-lg bg-muted" />
      <div className="h-24 animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
