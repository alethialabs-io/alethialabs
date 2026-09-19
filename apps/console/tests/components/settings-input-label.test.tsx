// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A settings row's input is NAMED BY ITS ROW, asserted through the accessible name.
//
// The release gate's audit leg scored axe `label` (critical, WCAG A) on four inputs across four
// routes — `/[org]/~/settings{,/general}` at 3 nodes and `/[org]/[project]/settings{,/general}`
// at 1 — in both themes. Each was a raw `<input>` written straight into a `SettingsField`, whose
// label is a `<span id>` rather than a `<label for>` (the control column can hold several
// controls, and a `<label for>` binds exactly one). Visible label, no programmatic one.
//
// This runs against the source rather than against a rendered page for the reason the gate
// itself proved: the audit that found this takes an hour, runs only on a promotion PR, and its
// verdict arrives as a ratchet entry. `getByRole(… { name })` asks the same question axe asks —
// what is this control's accessible name — in milliseconds, on every commit.
//
// BOTH DIRECTIONS, because the failure this file exists to catch is silent in one of them: an
// input that is merely *near* its label reads as fine on screen and announces nothing.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsField, SettingsInput } from "@/components/settings/settings-ui";

describe("SettingsInput", () => {
	it("takes its accessible name from the SettingsField row it sits in", () => {
		render(
			<SettingsField label="Organization name" hint="Shown across the console.">
				<SettingsInput defaultValue="Acme" />
			</SettingsField>,
		);
		// The name is the row's VISIBLE label — not a retyped copy of it, which is what drifts.
		expect(
			screen.getByRole("textbox", { name: "Organization name" }),
		).toBeInTheDocument();
	});

	it("lets an explicit aria-label win, for a control the row label does not fully name", () => {
		render(
			<SettingsField label="Organization URL">
				<SettingsInput aria-label="Organization slug" defaultValue="acme" />
			</SettingsField>,
		);
		expect(
			screen.getByRole("textbox", { name: "Organization slug" }),
		).toBeInTheDocument();
		// …and the row label is then NOT also announced: two names is one name too many.
		expect(
			screen.queryByRole("textbox", { name: "Organization URL" }),
		).toBeNull();
	});

	it("forwards className untouched, so a row that must not look filled still does not", () => {
		// The org slug field is a bare input inside a prefix box: no border, no focus ring, no
		// `w-full`. `SettingsInput` deliberately applies NO default classes, because a default
		// underneath would have changed how that row looks while claiming to change only its name.
		render(
			<SettingsField label="Organization URL">
				<SettingsInput className="border-0 bg-transparent" defaultValue="acme" />
			</SettingsField>,
		);
		const input = screen.getByRole("textbox", { name: "Organization URL" });
		expect(input.className).toBe("border-0 bg-transparent");
	});

	it("names nothing outside a SettingsField rather than inventing a name", () => {
		// The hook answers `null` above the provider. An input with no row is unnamed, and that
		// is honest — the alternative is a component that silently points at an id that is not
		// there, which axe reports as a DIFFERENT violation and is harder to trace back here.
		render(<SettingsInput defaultValue="loose" />);
		const input = screen.getByRole("textbox");
		expect(input.getAttribute("aria-labelledby")).toBeNull();
		expect(input.getAttribute("aria-label")).toBeNull();
	});
});
