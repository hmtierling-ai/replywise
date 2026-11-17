import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { formatThreadTime } from "@/lib/inbox-format";
import { LocalTime } from "./local-time";

describe("LocalTime", () => {
  it("renders the server text first, then the browser-local text", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T15:00:00Z"));
    const iso = "2026-03-04T09:05:00.000Z";
    render(<LocalTime iso={iso} serverText="SERVER" />);
    const el = screen.getByText(formatThreadTime(new Date(iso), new Date()));
    expect(el.tagName).toBe("TIME");
    expect(el).toHaveAttribute("dateTime", iso);
    expect(screen.queryByText("SERVER")).toBeNull();
    vi.useRealTimers();
  });
});
