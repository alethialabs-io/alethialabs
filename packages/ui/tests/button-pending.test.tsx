// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Button `pending` and the inline `[·]` loader (polish-wave spec §2, #7740). A pending button is
// disabled, says `aria-busy`, keeps its accessible name, swaps its leading icon for the mark (or
// prepends the mark when it has none), and holds the width it had at rest.

import { render, screen } from "@testing-library/react"
import { createRef } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Button } from "../src/button"
import { Spinner } from "../src/spinner"

/** A stand-in for a lucide icon: a component element, which is what `pending` treats as the icon. */
function PlusIcon() {
  return <svg data-testid="plus-icon" />
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("Button pending", () => {
  it("is disabled and busy, and keeps its name", () => {
    render(<Button pending>Applying…</Button>)
    const button = screen.getByRole("button", { name: "Applying…" })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute("aria-busy", "true")
    expect(button).toHaveAttribute("data-pending")
    expect(button.className).toContain("disabled:cursor-progress")
  })

  it("swaps a leading icon for the decorative mark", () => {
    render(
      <Button pending>
        <PlusIcon />
        Create
      </Button>,
    )
    expect(screen.queryByTestId("plus-icon")).toBeNull()
    const button = screen.getByRole("button", { name: "Create" })
    const mark = button.querySelector('[data-slot="button-pending-mark"]')
    expect(mark).not.toBeNull()
    expect(mark).toHaveAttribute("aria-hidden", "true")
    expect(button.firstElementChild).toBe(mark)
  })

  it("prepends the mark when the label has no icon, and draws nothing when not pending", () => {
    const { rerender } = render(<Button pending={false}>Save</Button>)
    const button = screen.getByRole("button", { name: "Save" })
    expect(button.querySelector('[data-slot="button-pending-mark"]')).toBeNull()
    expect(button).not.toBeDisabled()
    expect(button).not.toHaveAttribute("aria-busy")

    rerender(<Button pending>Save</Button>)
    expect(button.firstElementChild).toHaveAttribute("data-slot", "button-pending-mark")
    expect(button).toHaveTextContent("Save")
  })

  it("does not treat a host element such as <span> as the icon", () => {
    render(
      <Button pending>
        <span data-testid="label">Deploy</span>
      </Button>,
    )
    expect(screen.getByTestId("label")).toBeInTheDocument()
  })

  it("holds the resting width while pending and lets go after", () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(132)
    const { rerender } = render(<Button pending={false}>Promote</Button>)
    const button = screen.getByRole("button", { name: "Promote" })
    expect(button.style.minWidth).toBe("")

    rerender(<Button pending>Promote</Button>)
    expect(button.style.minWidth).toBe("132px")

    rerender(<Button pending={false}>Promote</Button>)
    expect(button.style.minWidth).toBe("")
  })

  it("still disables a button the caller disabled", () => {
    render(
      <Button pending={false} disabled>
        Save
      </Button>,
    )
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("still hands the caller's ref the element, object or callback", () => {
    const objectRef = createRef<HTMLButtonElement>()
    const seen: Array<HTMLButtonElement | null> = []
    render(
      <>
        <Button ref={objectRef}>One</Button>
        <Button ref={(node) => void seen.push(node)}>Two</Button>
      </>,
    )
    expect(objectRef.current).toBe(screen.getByRole("button", { name: "One" }))
    expect(seen[0]).toBe(screen.getByRole("button", { name: "Two" }))
  })
})

describe("Spinner", () => {
  it("is the [·] mark, announced as a loading status, at 16px unless sized", () => {
    render(<Spinner />)
    const status = screen.getByRole("status", { name: "Loading" })
    expect(status.tagName.toLowerCase()).toBe("svg")
    expect(status).toHaveAttribute("width", "16")
    expect(status.querySelector(".ah-loader__dot")).not.toBeNull()
  })

  it("takes the old lucide `size` shorthand and a className", () => {
    render(<Spinner size={13} className="size-3" />)
    const status = screen.getByRole("status")
    expect(status).toHaveAttribute("width", "13")
    expect(status.getAttribute("class")).toContain("size-3")
  })
})
