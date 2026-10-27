// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings rows stack by the PANEL's width, not the viewport's (#6135, F027).
//
// At 400px the `label | control` row was a fixed `200px 1fr` grid: inputs shrank to ~90px, the org
// URL clipped and "Replace" left the card. The same squeeze happens just above `lg`, where the page
// splits into two columns beside the sidebar and each panel is narrower than that phone. So the row
// answers to its `SettingsPanel` through a container query, and these tests pin the two halves that
// make that work: the panel IS a container, and the row's two-column template is ONLY behind the
// container step.
//
// These are class assertions because jsdom evaluates no CSS, let alone a container query. What
// they cannot see is the rendered geometry; that is the release gate's 400px audit leg.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	OrgGeneralSkeleton,
} from "@/components/settings/general/general-states";
import {
	SettingsCardFoot,
	SettingsDangerRow,
	SettingsField,
	SettingsPanel,
} from "@/components/settings/settings-ui";

/** The class tokens of `el`. */
function classes(el: Element): string[] {
	return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** `el`'s nearest ancestor that declares `@container` (named or not), or null. */
function containerOf(el: Element): Element | null {
	let cur = el.parentElement;
	while (cur) {
		if (classes(cur).some((c) => c === "@container" || c.startsWith("@container/"))) return cur;
		cur = cur.parentElement;
	}
	return null;
}

/** The SettingsField row (the grid) holding the label `text`. */
function rowOf(text: string): Element {
	const row = screen.getByText(text).closest(".grid");
	if (!row) throw new Error(`no grid row around "${text}"`);
	return row;
}

describe("SettingsField inside a SettingsPanel", () => {
	it("stacks by default and goes two-column only at the panel's 32rem container step", () => {
		render(
			<SettingsPanel>
				<SettingsField label="Organization URL" hint="The slug for your org's URL.">
					<input aria-label="slug" />
				</SettingsField>
			</SettingsPanel>,
		);
		const row = classes(rowOf("Organization URL"));
		expect(row).toContain("grid-cols-1");
		expect(row).toContain("@lg:grid-cols-[200px_1fr]");
		// Every column template other than the single column sits behind the container variant —
		// a bare (or viewport-prefixed) `grid-cols-[200px_1fr]` is the squeeze this issue removed.
		const templates = row.filter((c) => c.includes("grid-cols-") && c !== "grid-cols-1");
		expect(templates.length).toBeGreaterThan(0);
		for (const t of templates) expect(t.startsWith("@lg:")).toBe(true);
	});

	it("measures the SettingsPanel, which is the query container", () => {
		const { container } = render(
			<SettingsPanel>
				<SettingsField label="Description">
					<textarea aria-label="desc" />
				</SettingsField>
			</SettingsPanel>,
		);
		const panel = container.firstElementChild;
		expect(panel).not.toBeNull();
		expect(containerOf(rowOf("Description"))).toBe(panel);
	});
});

describe("the sibling rows wrap instead of squeezing", () => {
	it("SettingsCardFoot wraps and keeps its actions right-aligned", () => {
		render(
			<SettingsPanel>
				<SettingsCardFoot note="Applies across the console">
					<button type="button">Save</button>
				</SettingsCardFoot>
			</SettingsPanel>,
		);
		const actions = screen.getByRole("button", { name: "Save" }).parentElement;
		expect(actions && classes(actions)).toContain("ml-auto");
		expect(actions?.parentElement && classes(actions.parentElement)).toContain("flex-wrap");
	});

	it("SettingsDangerRow wraps its action under the text", () => {
		render(
			<SettingsPanel danger>
				<SettingsDangerRow title="Delete organization" description="Removes everything.">
					<button type="button">Delete</button>
				</SettingsDangerRow>
			</SettingsPanel>,
		);
		const group = screen.getByRole("group", { name: "Delete organization" });
		expect(classes(group)).toContain("flex-wrap");
	});
});

describe("the General skeleton mirrors the same container geometry (B2)", () => {
	it("each skeleton panel is a container and its rows go side by side only behind @lg:", () => {
		const { container } = render(<OrgGeneralSkeleton />);
		const panels = [...container.querySelectorAll("div")].filter((d) =>
			classes(d).includes("@container"),
		);
		// Organization profile, Defaults, Danger zone.
		expect(panels).toHaveLength(3);
		const rows = [...container.querySelectorAll("div")].filter((d) =>
			classes(d).includes("py-[15px]"),
		);
		expect(rows.length).toBe(8);
		for (const r of rows) {
			const c = classes(r);
			expect(c).toContain("flex-col");
			expect(c).toContain("@lg:flex-row");
			expect(c).not.toContain("flex-row");
		}
	});
});
