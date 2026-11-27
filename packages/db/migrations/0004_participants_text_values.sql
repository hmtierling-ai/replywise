-- participants_text from 0003 was lower(participants::text): it held the JSON keys "name" and
-- "address", null and JSON punctuation, so searches such as "re" or "name" matched every thread.
-- It now holds only the participant values (display names and addresses), lower-cased and
-- space-separated. A generated column needs an immutable expression without subqueries, hence
-- the IMMUTABLE SQL function (it only uses immutable built-ins).
CREATE OR REPLACE FUNCTION "public"."participants_search_text"(participants jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT coalesce(
    lower(string_agg(
      coalesce(p.value ->> 'name' || ' ', '') || coalesce(p.value ->> 'address', ''),
      ' ' ORDER BY p.ordinality
    )),
    ''
  )
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(participants) = 'array' THEN participants ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS p(value, ordinality)
$$;--> statement-breakpoint
DROP INDEX IF EXISTS "threads_participants_trgm_idx";--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "participants_text";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "participants_text" text GENERATED ALWAYS AS (participants_search_text(participants)) STORED;--> statement-breakpoint
CREATE INDEX "threads_participants_trgm_idx" ON "threads" USING gin ("participants_text" gin_trgm_ops);
