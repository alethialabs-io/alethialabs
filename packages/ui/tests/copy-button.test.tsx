// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit test for the CopyButton: clicking writes the given `text` to the
// clipboard, swaps the Copy icon for the Check confirmation icon, then reverts
// after the 2s timeout. Also exercises the missing-clipboard path (a page served over plain HTTP,
// where `navigator.clipboard` is undefined): the selection-copy fallback, and its failure.
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

	it("shows the copied confirmation state then reverts after 2s", async () => {
		vi.useFakeTimers();
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubClipboard({ writeText });
		render(<CopyButton text="hello" />);

		expect(isCopiedState()).toBe(false);

		await act(async () => {
			fireEvent.click(screen.getByRole("button"));
		});

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

	it("falls back to a selection copy when the clipboard API is missing, and confirms it", async () => {
		stubClipboard(undefined);
		const execCommand = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
		render(<CopyButton text="hello" />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button"));
		});

		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(isCopiedState()).toBe(true);
	});

	it("says it could not copy, instead of confirming, when no copy is possible", async () => {
		stubClipboard(undefined);
		Object.defineProperty(document, "execCommand", {
			value: vi.fn().mockReturnValue(false),
			configurable: true,
			writable: true,
		});
		render(<CopyButton text="hello" />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button"));
		});

		expect(isCopiedState()).toBe(false);
		expect(screen.getByRole("button", { name: /couldn't copy — select and copy manually/i })).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(/select and copy manually/);
	});
});
