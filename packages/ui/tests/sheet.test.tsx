// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// SheetContent's `overlayProps` (#5706). A sheet whose root mounts inside another open dialog is a
// NESTED base-ui dialog, and base-ui renders a nested dialog's backdrop only with `forceRender`
// (`DialogBackdrop`: `enabled: forceRender || !nested`). Before this prop SheetContent could not
// pass it, so the Elench thread-rail sheet — mounted inside the Elench modal — had no scrim.
//
// What this locks: (1) a top-level sheet renders its overlay with no props at all — the behaviour
// every existing caller relies on; (2) a nested sheet renders none by default — base-ui's rule,
// stated here so a base-ui upgrade that changes it is noticed; (3) `overlayProps.forceRender`
// renders it, merges a caller's class onto the token-based base, and a click on it closes only
// the nested sheet.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../src/dialog";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../src/sheet";
import type { ComponentProps } from "react";

type OverlayProps = ComponentProps<typeof SheetContent>["overlayProps"];

/** Every sheet overlay currently in the document. */
function sheetOverlays(): Element[] {
  return Array.from(document.querySelectorAll('[data-slot="sheet-overlay"]'));
}

/** A sheet opened from inside an open dialog, with a trigger so focus return can be read. */
function NestedSheet({ overlayProps }: { overlayProps?: OverlayProps }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Outer</DialogTitle>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger>Open sheet</SheetTrigger>
          <SheetContent side="left" showCloseButton={false} overlayProps={overlayProps}>
            <SheetTitle>Inner</SheetTitle>
          </SheetContent>
        </Sheet>
      </DialogContent>
    </Dialog>
  );
}

describe("SheetContent overlay", () => {
  it("renders the overlay for a top-level sheet with no overlayProps (existing callers)", async () => {
    render(
      <Sheet>
        <SheetTrigger>Open sheet</SheetTrigger>
        <SheetContent>
          <SheetTitle>Top</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await screen.findByRole("dialog", { name: "Top" });
    const overlays = sheetOverlays();
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toHaveClass("bg-overlay", "z-[var(--z-overlay)]");
  });

  it("renders no overlay for a nested sheet by default", async () => {
    render(<NestedSheet />);
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await screen.findByRole("dialog", { name: "Inner" });
    expect(sheetOverlays()).toHaveLength(0);
  });

  it("renders a nested sheet's overlay with forceRender, and merges the caller's class", async () => {
    render(
      <NestedSheet
        overlayProps={{ forceRender: true, className: "z-[var(--z-overlay-nested)] lg:hidden" }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open sheet" }));
    await screen.findByRole("dialog", { name: "Inner" });
    const overlays = sheetOverlays();
    expect(overlays).toHaveLength(1);
    const [overlay] = overlays;
    expect(overlay).toHaveClass("bg-overlay", "z-[var(--z-overlay-nested)]", "lg:hidden");
    // tailwind-merge drops the base layer, so the overlay sits on ONE layer, not two.
    expect(overlay).not.toHaveClass("z-[var(--z-overlay)]");
  });

  it("closes only the nested sheet on an overlay click, and returns focus to the trigger", async () => {
    render(<NestedSheet overlayProps={{ forceRender: true }} />);
    const trigger = screen.getByRole("button", { name: "Open sheet" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Inner" });
    const [overlay] = sheetOverlays();
    if (!overlay) throw new Error("the overlay did not render");
    await userEvent.click(overlay);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeInTheDocument();
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});
