// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Copying text to the clipboard in every browser context, including a self-host served over plain
// HTTP.
//
// `navigator.clipboard` is defined only in a secure context (HTTPS, or localhost). On any other
// origin it is `undefined`, so `navigator.clipboard.writeText(...)` throws before it can reject.
// The fallback is the older selection copy: a hidden, read-only textarea is selected and
// `document.execCommand("copy")` runs inside the click that called this. That command is deprecated
// but still implemented by every browser, and it does not need a secure context.
//
// The result says whether the copy happened, so a caller can tell the person when it did not.
// `scripts/check-secure-context-apis.mjs` keeps `navigator.clipboard` out of every other file.

/** Copies `text` to the clipboard; resolves true when the text was copied, false when it was not. */
export async function copyText(text: string): Promise<boolean> {
	const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
	if (clipboard?.writeText) {
		try {
			await clipboard.writeText(text);
			return true;
		} catch {
			// Refused (permission, focus); the selection copy below may still work.
		}
	}
	return selectionCopy(text);
}

/**
 * Where the helper textarea goes: inside the open modal that holds focus, when there is one, else
 * the body. A modal's focus trap (Radix `FocusScope`) pulls focus back from anything outside it,
 * so a textarea on the body would be copied from with nothing selected.
 */
function helperContainer(focused: Element | null): HTMLElement {
	const dialog = focused?.closest('[role="dialog"], [role="alertdialog"]');
	return dialog instanceof HTMLElement ? dialog : document.body;
}

/**
 * The selection-based copy, for a page with no Clipboard API. Trusts `execCommand` only when the
 * helper really holds focus and the whole text is selected: a command run over an empty selection
 * can report success while the clipboard is unchanged. Restores focus afterwards.
 */
function selectionCopy(text: string): boolean {
	if (typeof document === "undefined" || !document.body) return false;
	const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.setAttribute("aria-hidden", "true");
	area.style.position = "fixed";
	area.style.top = "0";
	area.style.left = "0";
	area.style.opacity = "0";
	area.style.pointerEvents = "none";
	helperContainer(focused).appendChild(area);
	try {
		area.focus({ preventScroll: true });
		area.select();
		// `select()` alone selects nothing on iOS Safari.
		area.setSelectionRange(0, text.length);
		const ready =
			document.activeElement === area && area.selectionStart === 0 && area.selectionEnd === text.length;
		if (!ready) return false;
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		area.remove();
		focused?.focus();
	}
}
