import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildNavItems } from "./nav-items";
import { NavLinks, NavLinksView } from "./nav-links";

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

describe("NavLinksView counts", () => {
  it("shows a hidden count badge without changing link names", () => {
    render(
      <NavLinksView
        items={buildNavItems()}
        label="Mailbox views"
        pathname="/inbox"
        counts={{
          inbox: 12,
          other: 150,
          categories: {
            urgent: 0,
            important: 0,
            needs_reply: 2,
            informational: 0,
            low_priority: 0,
          },
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Other" })).toHaveTextContent("99+");
    expect(screen.getByRole("link", { name: "Needs Reply" })).toHaveTextContent("2");
    expect(screen.getByRole("link", { name: "Urgent" })).not.toHaveTextContent(/\d/);
  });
});
