"use client";
import Form from "next/form";
import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Local search (spec M6 §5.1): GET /search?q=…; "/" focuses it unless the user is typing. */
export function SearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || TYPING_TAGS.has(target.tagName))) return;
      event.preventDefault();
      ref.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <Form action="/search" role="search" className="px-4 pt-4 sm:px-6">
      <label htmlFor="mail-search" className="sr-only">
        Search mail
      </label>
      <Input
        ref={ref}
        id="mail-search"
        name="q"
        type="search"
        defaultValue={defaultValue}
        maxLength={200}
        autoComplete="off"
        placeholder="Search mail (press /)"
      />
    </Form>
  );
}
