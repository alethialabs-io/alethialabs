// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The toast host's loading icon (#7871): a `toast.loading(…)` draws the inline [·] mark, decorative
// beside the toast's own text, instead of a spinning lucide Loader2.

import { act, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../src/sonner";

beforeEach(() => {
	// jsdom has no matchMedia; sonner reads it for the system theme.
	vi.stubGlobal(
		"matchMedia",
		(query: string): MediaQueryList => {
			const list = new EventTarget();
			return Object.assign(list, {
				matches: false,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
			});
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	act(() => {
		toast.dismiss();
	});
});

describe("Toaster", () => {
	it("draws the [·] mark as a loading toast's icon", async () => {
		render(<Toaster />);
		act(() => {
			toast.loading("Uploading report…");
		});

		const text = await screen.findByText("Uploading report…");
		const item = text.closest("[data-sonner-toast]");
		expect(item).not.toBeNull();
		const mark = item?.querySelector('[data-slot="mark-glyph"]');
		expect(mark).not.toBeNull();
		expect(mark).toHaveAttribute("aria-hidden", "true");
		expect(item?.querySelector(".animate-spin")).toBeNull();
	});
});
