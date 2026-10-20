// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A read-only value is not drawn on the input surface (#6117, F039).
//
// The settings input surface is a sunken background with a strong border
// (`apps/console/components/settings/settings-ui.tsx` `settingsControl`). A value drawn that way
// reads as a field you can type in. This locks the absence of both halves of that surface.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReadOnlyValue } from "../src/read-only-value";

describe("ReadOnlyValue", () => {
	it("is plain text, not an input surface", () => {
		render(<ReadOnlyValue>/acme/payments</ReadOnlyValue>);
		const el = screen.getByText("/acme/payments");
		expect(el.tagName).not.toBe("INPUT");
		const classes = [...el.classList];
		expect(classes.some((c) => c.startsWith("bg-"))).toBe(false);
		expect(classes.some((c) => c === "border" || c.startsWith("border-"))).toBe(false);
		expect(el.classList).toContain("text-text-secondary");
	});

	it("keeps a settings control's height as a minimum so rows line up", () => {
		render(<ReadOnlyValue>x</ReadOnlyValue>);
		expect(screen.getByText("x").classList).toContain("min-h-[38px]");
	});

	it("sets identifiers in the mono voice when asked", () => {
		render(<ReadOnlyValue mono>id</ReadOnlyValue>);
		const el = screen.getByText("id");
		expect(el.classList).toContain("font-mono");
		expect(el.classList).toContain("text-ui-sm");
	});
});
