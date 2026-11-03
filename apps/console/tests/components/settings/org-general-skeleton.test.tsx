// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6352 (RUBRIC B2): the org General skeleton is the form's layout, box for box. The release gate
// scored the old one 0.182 against a 0.02 budget: it drew every row as a one-line label beside one
// bar, while the form's rows are as tall as their wrapped hints and their real controls. jsdom has no
// layout, so this pins the two things that decide the geometry: the same sections, rows, hints,
// notes and danger rows in the same order and the same column grid as the form, and a placeholder
// at each real control's own height.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/server/actions/org-settings", () => ({
	saveOrgGeneral: vi.fn(),
	deleteOrganization: vi.fn(),
}));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { OrgGeneralSkeleton } from "@/components/settings/general/org-general-skeleton";
import { ACME, renderOrgGeneral } from "../../support/general-settings";

/** Text with its whitespace runs collapsed, the way it reads on screen. */
function words(el: Element | null | undefined): string {
	return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A `SettingsField` row's label: the `<span id>` its controls point `aria-labelledby` at. */
const LABEL = "section span[id].font-medium";

/** Every `SettingsField` row in `root`: its label span's grandparent, keyed by the label. */
function fieldRows(root: Element): Map<string, Element> {
	const rows = new Map<string, Element>();
	for (const label of root.querySelectorAll(LABEL)) {
		const row = label.parentElement?.parentElement;
		if (row) rows.set(words(label), row);
	}
	return rows;
}

/**
 * The page's geometry-deciding outline: each section's heading, whether it sits in the two-column
 * grid, its rows' label and hint, the fixed notes under a control, the Save band's note, and each
 * danger row's title and description, with the org's name taken out.
 */
function outline(root: Element, orgName: string) {
	return [...root.querySelectorAll("section")].map((section) => ({
		heading: words(section.querySelector("h2")),
		// The wrapper's classes: `SettingsColumns`' grid for the two side-by-side panels, none for the
		// full-width Danger zone.
		wrapper: section.parentElement?.className ?? null,
		rows: [...section.querySelectorAll(LABEL.replace("section ", ""))].map((label) => {
			const row = label.parentElement?.parentElement;
			return {
				label: words(label),
				hint: words(label.nextElementSibling),
				notes: [...(row?.lastElementChild?.querySelectorAll("span.text-ui-2xs") ?? [])].map(words),
			};
		}),
		saveNote: words(section.querySelector(".bg-surface-sunken.border-t > span")),
		dangerRows: [...section.querySelectorAll('[role="group"]')].map((group) => ({
			title: words(group.querySelector("[id]")),
			description: words(group.querySelector(".max-w-\\[52ch\\]")).replace(orgName, "").replace(/\s+/g, " "),
		})),
	}));
}

describe("OrgGeneralSkeleton — the form's layout while the read is pending", () => {
	it("draws the form's sections, rows, hints, notes and danger rows, in the form's column grid", () => {
		const skeleton = render(<OrgGeneralSkeleton />);
		const skeletonOutline = outline(skeleton.container, ACME.name);
		skeleton.unmount();
		const form = renderOrgGeneral();
		const formOutline = outline(form.container, ACME.name);

		expect(skeletonOutline).toEqual(formOutline);
		// The comparison is about something: three sections, eight field rows, two danger rows, and
		// the profile and Defaults panels side by side over a full-width Danger zone.
		const inColumns = (wrapper: string | null) => wrapper?.includes("lg:grid-cols-2") ?? false;
		expect(formOutline.map((s) => [s.heading, inColumns(s.wrapper), s.rows.length, s.dangerRows.length])).toEqual([
			["Organization profile", true, 5, 0],
			["Defaults", true, 3, 0],
			["Danger zone", false, 0, 2],
		]);
	});

	it("puts a placeholder at each real control's height", () => {
		const skeleton = render(<OrgGeneralSkeleton />);
		const sRows = fieldRows(skeleton.container);
		const control = (label: string, selector: string) =>
			sRows.get(label)?.lastElementChild?.querySelector(`[data-slot="skeleton"]${selector}`) ?? null;

		// The logo's 56px avatar; the 38px inputs; the textarea's 64px floor; the 36px select triggers.
		expect(control("Logo", ".size-14")).not.toBeNull();
		expect(control("Organization name", ".h-\\[38px\\]")).not.toBeNull();
		expect(control("Organization URL", ".h-\\[38px\\]")).not.toBeNull();
		expect(control("Description", ".h-16")).not.toBeNull();
		expect(control("Data region", ".h-9")).not.toBeNull();
		expect(control("Default Project environment", ".h-9")).not.toBeNull();
		expect(control("Terraform version", ".h-\\[38px\\]")).not.toBeNull();
		skeleton.unmount();

		// …and those ARE the form's controls' heights, so a resized control fails here rather than on
		// the release gate.
		const fRows = fieldRows(renderOrgGeneral().container);
		const formControl = (label: string, selector: string) =>
			fRows.get(label)?.lastElementChild?.querySelector(selector) ?? null;
		expect(formControl("Logo", "div[style*='height: 56px']")).not.toBeNull();
		expect(formControl("Organization name", "input.h-\\[38px\\]")).not.toBeNull();
		expect(formControl("Organization URL", "div.h-\\[38px\\]")).not.toBeNull();
		expect(formControl("Description", "textarea.min-h-16")).not.toBeNull();
		expect(formControl("Data region", '[data-slot="select-trigger"][data-size="default"]')).not.toBeNull();
		expect(formControl("Default Project environment", '[data-slot="select-trigger"][data-size="default"]')).not.toBeNull();
		expect(formControl("Terraform version", "input.h-\\[38px\\]")).not.toBeNull();
	});

	it("is one hidden region the page can tell from the form", () => {
		const { container } = render(<OrgGeneralSkeleton />);
		const root = container.querySelector('[data-slot="org-general-skeleton"]');
		expect(root).not.toBeNull();
		expect(root?.getAttribute("aria-hidden")).toBe("true");
		expect(container.querySelector("input, textarea, button, form")).toBeNull();
	});
});
