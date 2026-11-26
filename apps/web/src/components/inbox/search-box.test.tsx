import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchBox } from "./search-box";

vi.mock("next/form", () => ({
  default: (props: ComponentProps<"form">) => <form {...props} />,
}));

describe("SearchBox", () => {
  it("focuses on / and keeps the query", async () => {
    render(<SearchBox defaultValue="invoice" />);
    const input = screen.getByRole("searchbox", { name: "Search mail" });
    expect(input).toHaveValue("invoice");
    await userEvent.keyboard("/");
    expect(input).toHaveFocus();
  });

  it("does not steal / typed into another field", async () => {
    render(
      <>
        <textarea aria-label="Reply draft" />
        <SearchBox />
      </>,
    );
    const textarea = screen.getByRole("textbox", { name: "Reply draft" });
    await userEvent.click(textarea);
    await userEvent.keyboard("/");
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue("/");
  });
});
