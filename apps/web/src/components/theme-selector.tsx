"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const OPTIONS = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <fieldset className="inline-flex gap-1 rounded-lg border border-border p-1">
      <legend className="sr-only">Theme</legend>
      {OPTIONS.map((option) => {
        const selected = mounted && theme === option.value;
        return (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant={selected ? "secondary" : "ghost"}
            aria-pressed={selected}
            onClick={() => setTheme(option.value)}
          >
            {option.label}
          </Button>
        );
      })}
    </fieldset>
  );
}
