// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The runner dialog's CopyField: the runner token is shown once, so a copy that did not happen must
// say so and leave the value selected for a manual copy — never a check mark over an unchanged
// clipboard.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/copy-text", () => ({ copyText: vi.fn() }));

import { copyText } from "@repo/ui/copy-text";
import { CopyField } from "@/components/runners/copy-field";

afterEach(() => {
	vi.clearAllMocks();
	window.getSelection()?.removeAllRanges();
});

/** Clicks the field's copy button and lets the copy settle. */
async function clickCopy() {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: /copy runner token/i }));
	});
}

describe("CopyField", () => {
	it("confirms a copy that happened", async () => {
		vi.mocked(copyText).mockResolvedValue(true);
		render(<CopyField label="Runner Token" value="tok-123" />);
		await clickCopy();
		expect(copyText).toHaveBeenCalledWith("tok-123");
		expect(screen.getByRole("button", { name: /runner token copied/i })).toBeInTheDocument();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("says it could not copy and selects the value when the copy did not happen", async () => {
		vi.mocked(copyText).mockResolvedValue(false);
		render(<CopyField label="Runner Token" value="tok-123" />);
		await clickCopy();
		expect(screen.getByRole("status")).toHaveTextContent(/couldn't copy — select and copy manually/i);
		expect(screen.queryByRole("button", { name: /runner token copied/i })).toBeNull();
		expect(window.getSelection()?.toString()).toBe("tok-123");
	});
});
