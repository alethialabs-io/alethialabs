// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The point of migrating Select to base-ui: base-ui's `Select.Value` shows the raw selected VALUE,
// not the chosen item's LABEL, unless the Root gets a value→label map. Our wrapper builds that map
// eagerly from the `SelectItem` children, so an id→name select shows the NAME on the closed trigger
// (no per-form `items` prop, no first-render flicker). These tests pin that behavior.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../src/select";

function IdNameSelect({ value }: { value?: string }) {
  return (
    <Select value={value}>
      <SelectTrigger>
        <SelectValue placeholder="Select an account" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="acc-1a2b">Production AWS</SelectItem>
        <SelectItem value="acc-9z8y">Staging GCP</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("Select value → label resolution", () => {
  it("closed trigger shows the item LABEL for a controlled id value (not the raw id)", () => {
    render(<IdNameSelect value="acc-1a2b" />);
    expect(screen.getByText("Production AWS")).toBeInTheDocument();
    expect(screen.queryByText("acc-1a2b")).not.toBeInTheDocument();
  });

  it("shows the label on FIRST render (no flicker to the raw value)", () => {
    // If the label only resolved after the popup mounted, this would find the id instead.
    const { container } = render(<IdNameSelect value="acc-9z8y" />);
    expect(container.textContent).toContain("Staging GCP");
    expect(container.textContent).not.toContain("acc-9z8y");
  });

  it("renders the placeholder when nothing is selected", () => {
    render(<IdNameSelect />);
    expect(screen.getByText("Select an account")).toBeInTheDocument();
  });
});
