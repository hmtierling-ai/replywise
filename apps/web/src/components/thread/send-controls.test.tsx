import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SendControls } from "./send-controls";

const { scheduleSendAction, refresh } = vi.hoisted(() => ({
  scheduleSendAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/app/(app)/thread/[id]/send-actions", () => ({ scheduleSendAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const BODY = "Hi Ada,\n\nYes.";

function renderWithEditor(value: string) {
  render(
    <>
      <textarea id="draft-body-d1" aria-label="Reply draft" defaultValue={value} />
      <SendControls draftId="d1" savedBody={BODY} to="Ada <ada@x.com>" subject="Re: Contract" />
    </>,
  );
}

describe("SendControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduleSendAction.mockResolvedValue({ ok: true });
  });

  it("shows recipient, subject and body, then confirms the stored body", async () => {
    renderWithEditor(BODY);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Ada <ada@x.com>");
    expect(dialog).toHaveTextContent("Re: Contract");
    expect(dialog).toHaveTextContent("Yes.");
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(scheduleSendAction).toHaveBeenCalledWith({ draftId: "d1", expectedBody: BODY });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("asks to save unsaved edits first and offers no Send now", async () => {
    renderWithEditor("Hi Ada,\n\nNo.");
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    expect(screen.getByRole("alert")).toHaveTextContent("unsaved edits");
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("shows the fixed copy when the action refuses", async () => {
    scheduleSendAction.mockResolvedValue({ ok: false, error: "send_rate_limited" });
    renderWithEditor(BODY);
    await userEvent.click(screen.getByRole("button", { name: "Send…" }));
    await userEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("20 replies");
  });
});
