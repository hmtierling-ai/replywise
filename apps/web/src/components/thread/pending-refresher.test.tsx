import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingRefresher } from "./pending-refresher";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("PendingRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes every 2 s while active", () => {
    render(<PendingRefresher active />);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("never refreshes when inactive", () => {
    render(<PendingRefresher active={false} />);
    vi.advanceTimersByTime(20_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stops after 3 minutes", () => {
    render(<PendingRefresher active />);
    vi.advanceTimersByTime(190_000);
    const calls = refresh.mock.calls.length;
    vi.advanceTimersByTime(20_000);
    expect(refresh).toHaveBeenCalledTimes(calls);
  });
});
