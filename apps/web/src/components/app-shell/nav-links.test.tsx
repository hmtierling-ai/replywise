import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildNavItems } from "./nav-items";
import { NavLinks } from "./nav-links";

vi.mock("next/navigation", () => ({ usePathname: () => "/inbox/needs-reply" }));

describe("NavLinks", () => {
  it("marks only the current view as the current page", () => {
    render(<NavLinks items={buildNavItems()} label="Mailbox views" />);
    expect(screen.getByRole("link", { name: "Needs Reply" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "All mail" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("navigation", { name: "Mailbox views" })).toBeInTheDocument();
  });
});
