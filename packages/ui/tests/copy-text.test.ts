// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// copyText: the Clipboard API where it exists, a selection copy where it does not (a page served
// over plain HTTP has no `navigator.clipboard`), and an honest `false` when neither copied.

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/copy-text";

/** Installs `impl` as navigator.clipboard; `undefined` is an insecure context. */
function stubClipboard(impl?: { writeText: (t: string) => Promise<void> }) {
	Object.defineProperty(navigator, "clipboard", { value: impl, configurable: true, writable: true });
}

/** Installs a document.execCommand that records the selected text and returns `result`. */
function stubExecCommand(result: boolean | Error) {
	const selected: string[] = [];
	const exec = vi.fn((command: string) => {
		const active = document.activeElement;
		if (command === "copy" && active instanceof HTMLTextAreaElement) selected.push(active.value);
		if (result instanceof Error) throw result;
		return result;
	});
	Object.defineProperty(document, "execCommand", { value: exec, configurable: true, writable: true });
	return { exec, selected };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("copyText", () => {
	it("uses the Clipboard API when it exists", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		stubClipboard({ writeText });
		const { exec } = stubExecCommand(true);
		expect(await copyText("token-1")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("token-1");
		expect(exec).not.toHaveBeenCalled();
	});

	it("over plain HTTP (no navigator.clipboard) copies the text through a selection", async () => {
		stubClipboard(undefined);
		const { exec, selected } = stubExecCommand(true);
		expect(await copyText("token-2")).toBe(true);
		expect(exec).toHaveBeenCalledWith("copy");
		expect(selected).toEqual(["token-2"]);
		// The helper element is gone afterwards.
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("falls back when the Clipboard API refuses", async () => {
		stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
		const { selected } = stubExecCommand(true);
		expect(await copyText("token-3")).toBe(true);
		expect(selected).toEqual(["token-3"]);
	});

	it("returns false when nothing could copy, whether the command declines or throws", async () => {
		stubClipboard(undefined);
		stubExecCommand(false);
		expect(await copyText("x")).toBe(false);
		stubExecCommand(new Error("unsupported"));
		expect(await copyText("x")).toBe(false);
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("gives focus back to the element that had it", async () => {
		stubClipboard(undefined);
		stubExecCommand(true);
		const button = document.createElement("button");
		document.body.appendChild(button);
		button.focus();
		await copyText("x");
		expect(document.activeElement).toBe(button);
		button.remove();
	});

	describe("inside a modal's focus trap", () => {
		/**
		 * Builds an open dialog holding a focused button, and a trap that does what Radix FocusScope
		 * does: focus landing outside the dialog is pulled back to the button. `strict` also pulls
		 * focus back from anything inside the dialog other than the button.
		 */
		function trappedDialog(strict = false) {
			const dialog = document.createElement("div");
			dialog.setAttribute("role", "dialog");
			const button = document.createElement("button");
			dialog.appendChild(button);
			document.body.appendChild(dialog);
			button.focus();
			const trap = (e: FocusEvent) => {
				const target = e.target;
				if (!(target instanceof Node)) return;
				if (target === button) return;
				if (strict || !dialog.contains(target)) button.focus();
			};
			document.addEventListener("focusin", trap);
			return {
				button,
				dialog,
				done: () => {
					document.removeEventListener("focusin", trap);
					dialog.remove();
				},
			};
		}

		it("copies from inside the dialog, where the trap lets the helper keep focus", async () => {
			stubClipboard(undefined);
			const { selected } = stubExecCommand(true);
			const t = trappedDialog();
			try {
				expect(await copyText("runner-token")).toBe(true);
				expect(selected).toEqual(["runner-token"]);
				expect(document.activeElement).toBe(t.button);
				expect(t.dialog.querySelector("textarea")).toBeNull();
			} finally {
				t.done();
			}
		});

		it("reports false, and never runs the command, when the trap takes focus from the helper", async () => {
			stubClipboard(undefined);
			// A command that would claim success over an empty selection — the case the check exists for.
			const { exec } = stubExecCommand(true);
			const t = trappedDialog(true);
			try {
				expect(await copyText("runner-token")).toBe(false);
				expect(exec).not.toHaveBeenCalled();
			} finally {
				t.done();
			}
		});
	});
});
