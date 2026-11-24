import { AI_MODELS, REPLY_TONE_META, REPLY_TONES } from "@replywise/core";
import { getWritingPreferences } from "@replywise/db";
import { connection } from "next/server";
import { saveWritingPreferencesAction } from "@/app/(app)/settings/ai/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const textareaClass =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/** Reads the session and DB; render inside <Suspense>. */
export async function WritingSettings() {
  const user = await requireUser();
  await connection();
  const prefs = await getWritingPreferences(getDb(), user.id);

  return (
    <section
      aria-labelledby="ai-writing-heading"
      className="flex flex-col gap-3 border-t border-border pt-6"
    >
      <h2 id="ai-writing-heading" className="text-sm font-medium">
        Writing preferences
      </h2>
      <p className="text-xs text-muted-foreground">
        These shape the reply drafts Replywise writes. Drafts stay in Replywise until you choose to
        save one to Gmail; nothing is ever sent.
      </p>
      <form action={saveWritingPreferencesAction} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm">Default tone</legend>
          {REPLY_TONES.map((tone) => (
            <label key={tone} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="defaultTone"
                value={tone}
                defaultChecked={tone === prefs.defaultTone}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{REPLY_TONE_META[tone].label}</span>
                <span className="block text-muted-foreground">
                  {REPLY_TONE_META[tone].description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm">Reply model</legend>
          {AI_MODELS.map((option) => (
            <label key={option.id} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="generationModel"
                aria-label={`Reply model: ${option.label}`}
                value={option.id}
                defaultChecked={option.id === prefs.generationModel}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{option.label}</span>
                <span className="block text-muted-foreground">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="signature">Signature</Label>
          <textarea
            id="signature"
            name="signature"
            rows={3}
            maxLength={1000}
            defaultValue={prefs.signature}
            aria-describedby="signature-hint"
            className={textareaClass}
          />
          <p id="signature-hint" className="text-xs text-muted-foreground">
            Added to the end of drafts saved to Gmail.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="writingStyleNotes">Writing style notes</Label>
          <textarea
            id="writingStyleNotes"
            name="writingStyleNotes"
            rows={4}
            maxLength={2000}
            defaultValue={prefs.writingStyleNotes}
            aria-describedby="style-notes-hint"
            className={textareaClass}
          />
          <p id="style-notes-hint" className="text-xs text-muted-foreground">
            e.g. I write short paragraphs and sign off with &apos;Cheers&apos;.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="replyLanguage">Reply language</Label>
          <Input
            id="replyLanguage"
            name="replyLanguage"
            maxLength={35}
            defaultValue={prefs.replyLanguage ?? ""}
            placeholder="Same as the email"
            aria-describedby="reply-language-hint"
          />
          <p id="reply-language-hint" className="text-xs text-muted-foreground">
            Leave empty to reply in the language of the email.
          </p>
        </div>

        <div>
          <Button type="submit" variant="outline" size="sm">
            Save writing preferences
          </Button>
        </div>
      </form>
    </section>
  );
}
