// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Regression test for PopoverContent's `container` prop. base-ui's default portals the popup into the
// nearest floating-tree portal (e.g. an enclosing Dialog's subtree), where a later `position: relative`
// sibling can paint over it and swallow clicks (the Elench "Save as artifact" bug). `container` maps to
// base-ui `Popover.Portal`'s `root`, letting a caller portal the popup to `<body>` (or any node) so it
// escapes that subtree. This locks the passthrough the fix depends on.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../src/popover";

let mounted: HTMLElement[] = [];

/** A detached-then-attached container node, cleaned up after each test. */
function makeContainer(id: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-container", id);
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted = [];
});

describe("PopoverContent container", () => {
  it("portals the popup into the given container node", async () => {
    const user = userEvent.setup();
    const container = makeContainer("custom");
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent container={container}>
          <span>panel-body</span>
        </PopoverContent>
      </Popover>,
    );

    await user.click(screen.getByRole("button", { name: "Open" }));

    const body = await screen.findByText("panel-body");
    // The popup content lives inside the caller-provided container, not elsewhere in the tree.
    expect(container.contains(body)).toBe(true);
  });

  it("still renders the popup when no container is given (default portal)", async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <span>default-body</span>
        </PopoverContent>
      </Popover>,
    );

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("default-body")).toBeInTheDocument();
  });
});
