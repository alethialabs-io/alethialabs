// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the CopyButton: clicking writes the given `text` to the
// clipboard, swaps the Copy icon for the Check confirmation icon, then reverts
// after the 2s timeout. Also exercises the missing-clipboard path.
//
// We drive the button with `fireEvent` (not userEvent) on purpose: userEvent
// installs its OWN navigator.clipboard stub on setup, which would shadow the
// spy we need to assert against, and it deadlocks under fake timers.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "../src/copy-button";

/**
 * Installs a spy clipboard on navigator. Pass `undefined` to simulate an
 * environment with no clipboard API.
 */
function stubClipboard(impl?: { writeText: ReturnType<typeof vi.fn> }) {
	Object.defineProperty(navigator, "clipboard", {
		value: impl,
		configurable: true,
		writable: true,
	});
}

/** Returns the single <svg> lucide icon rendered inside the button. */
function icon() {
	const svg = screen.getByRole("button").querySelector("svg");
	if (!svg) throw new Error("CopyButton rendered no icon");
	return svg;
}

/** True when the button shows the Check confirmation icon (copied state). */
function isCopiedState() {
	// The Check icon carries `text-foreground`; the idle Copy icon does not.
	return icon().getAttribute("class")?.includes("text-foreground") ?? false;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("CopyButton", () => {
	it("writes the given text to the clipboard on click", () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubClipboard({ writeText });
		render(<CopyButton text="kafka://broker:9092" />);

		// Idle state: Copy icon, not the confirmation icon.
		expect(isCopiedState()).toBe(false);

		fireEvent.click(screen.getByRole("button", { name: /copy to clipboard/i }));

		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText).toHaveBeenCalledWith("kafka://broker:9092");
	});

	it("copies the exact prop value (not a hardcoded string)", () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubClipboard({ writeText });
		render(<CopyButton text="different-secret-token" />);

		fireEvent.click(screen.getByRole("button"));

		expect(writeText).toHaveBeenCalledWith("different-secret-token");
		expect(writeText).not.toHaveBeenCalledWith("kafka://broker:9092");
	});

	it("shows the copied confirmation state then reverts after 2s", () => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubClipboard({ writeText });
		render(<CopyButton text="hello" />);

		expect(isCopiedState()).toBe(false);

		fireEvent.click(screen.getByRole("button"));

		// Confirmation icon is now shown.
		expect(isCopiedState()).toBe(true);

		// Still confirmed just before the 2s timeout elapses.
		act(() => {
			vi.advanceTimersByTime(1999);
		});
		expect(isCopiedState()).toBe(true);

		// Reverts to the idle Copy icon once the full 2s passes.
		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(isCopiedState()).toBe(false);
	});

	it("does not enter the copied state when the clipboard API is missing", () => {
		stubClipboard(undefined);
		render(<CopyButton text="hello" />);

		// The component does not guard a missing clipboard, so the handler throws.
		// Capture it however it surfaces (sync throw or window error event) so the
		// suite stays green, then assert it never reached the confirmation state.
		const errors: unknown[] = [];
		const onError = (e: ErrorEvent) => {
			errors.push(e.error);
			e.preventDefault();
		};
		window.addEventListener("error", onError);
		try {
			fireEvent.click(screen.getByRole("button"));
		} catch (e) {
			errors.push(e);
		}
		window.removeEventListener("error", onError);

		expect(errors.length).toBeGreaterThan(0);
		expect(isCopiedState()).toBe(false);
	});
});
