// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// EVERY CONTROL IN THE THREE ENVIRONMENTS DIALOGS HAS AN ACCESSIBLE NAME, AND IT IS THE TEXT
// ALREADY BESIDE IT.
//
// The defect (#4630): `ToggleRow` wrapped its text and its `Switch` in a bare `<label>` and
// trusted implicit label association. That association reaches a LABELABLE element only, and
// `@repo/ui/switch` is base-ui, which renders a `<span role="switch">` — so the three promotion
// gates reached a screen reader as three identical unnamed switches. The same shape, for the same
// reason, hit both Select triggers in `PromoteDialog` and the base picker in
// `NewEnvironmentDialog`: base-ui stamps `role="combobox"` on the trigger, and a combobox is named
// from the AUTHOR only, so its visible text is not its name either.
//
// WHY THESE TESTS DO NOT STOP AT `getByRole(…, { name })`. jsdom's accname implementation falls
// back to the `title` attribute, so a role+name query alone can go green on the BROKEN tree the
// moment the name it asks for happens to be character-identical to a `title` someone put there for
// a tooltip. Every case below therefore asserts THREE things: the computed accessible name, the
// `aria-labelledby` attribute that is supposed to produce it (resolving to an element that is
// really rendered and really carries that text), and the ABSENCE of a `title` on the control — so
// the assertion cannot be satisfied by the fallback it is meant to rule out.
//
// MEASURED AGAINST THE PRE-FIX TREE, not assumed: with all three components restored to their
// parent commit, all 10 tests here fail — each with `Unable to find an accessible element with the
// role "switch"/"combobox"/"spinbutton" and name …`, which is the defect stated exactly. A test
// that would also have passed on the broken tree proves nothing, and for this defect that is the
// easy mistake to make, not a theoretical one.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/protection", () => ({
	getProtectionRules: vi.fn(async () => null),
	setProtectionRules: vi.fn(),
}));
vi.mock("@/app/server/actions/promotions", () => ({
	previewPromotion: vi.fn(async () => ({
		changes: [
			{ component_type: "service", key: "api", op: "CREATE" },
			{ component_type: "service", key: "legacy-worker", op: "DELETE" },
		],
		summary: ["1 add", "1 remove"],
		include_removals: false,
	})),
	promoteEnvironment: vi.fn(),
}));
vi.mock("@/app/server/actions/projects", () => ({
	addEnvironment: vi.fn(),
	duplicateEnvironment: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NewEnvironmentDialog } from "@/components/environments/new-environment-dialog";
import { PromoteDialog } from "@/components/environments/promote-dialog";
import { ProtectionRulesDialog } from "@/components/environments/protection-rules-dialog";
import { NAME_REQUIRED, unnamedControls } from "../support/accessible-names";

/**
 * The denominator for a TOGGLE's name — axe's `aria-toggle-field-name` (serious), verbatim.
 *
 * Composed here rather than folded into `tests/support/accessible-names.ts`: that file is the
 * shared denominator two other sweeps already measure themselves against, and widening it would
 * silently change what THEY report. This unit owns `components/environments/`, not that registry.
 */
const TOGGLE_ROLES =
	'[role="switch"], [role="checkbox"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="radio"]';

/** Every control either axe rule family requires a discernible name on. */
const NAMED_CONTROLS = `${NAME_REQUIRED}, ${TOGGLE_ROLES}`;

/**
 * `NAMED_CONTROLS` with base-ui's own focus guards subtracted — the one thing in the rendered tree
 * this unit is not answerable for.
 *
 * `FocusGuard` renders a visually-hidden `<span tabIndex={0}>` at each end of a popup, and under
 * Safari — which its UA sniff also reports for jsdom — it stamps `role="button"` on it and drops
 * the `aria-hidden` that would otherwise keep it out of the tree. Two of them bracket every
 * `Sheet`, so the sweep sees two unnamed commands that no file this unit may touch produces; they
 * come from `@base-ui-components`, not from `@repo/ui` and not from the console.
 *
 * The subtraction is per-clause and keyed on base-ui's own data attribute, which nothing we author
 * carries — narrow enough that a real unnamed control cannot hide behind it. It is NOT a filter on
 * the reported outerHTML: `unnamedControls` truncates that to 200 characters, and the attribute
 * falls outside the window on exactly these spans, so such a filter would match nothing and read
 * as a clean sweep that had quietly stopped subtracting.
 */
const OWN_NAMED_CONTROLS = NAMED_CONTROLS.split(/,\s*/)
	.map((clause) => `${clause}:not([data-base-ui-focus-guard])`)
	.join(", ");

/** The elements an `aria-labelledby` resolves to; `[]` when the attribute is absent or dangling. */
function labelledBy(control: Element): HTMLElement[] {
	const ids = (control.getAttribute("aria-labelledby") ?? "")
		.split(/\s+/)
		.filter(Boolean);
	return ids
		.map((id) => document.getElementById(id))
		.filter((el): el is HTMLElement => el !== null);
}

const ENVS = [
	{ id: "env-dev", name: "development", stage: "development" },
	{ id: "env-prod", name: "production", stage: "production" },
];

describe("ProtectionRulesDialog — the promotion gates are named", () => {
	/** The three gates, as the drawer renders them: visible title → the sentence under it. */
	const GATES: [string, RegExp][] = [
		["Require predecessor", /lower environment must have deployed/i],
		["Require verify pass", /elench report must have no unwaived/i],
		["Require approval", /reviewer must approve/i],
	];

	function renderDrawer() {
		return render(
			<ProtectionRulesDialog
				open
				onOpenChange={() => {}}
				projectId="p1"
				envId="env-prod"
				envName="production"
			/>,
		);
	}

	it.each(GATES)(
		"names the %s switch from the title rendered beside it",
		async (title, descPattern) => {
			renderDrawer();
			const sw = await screen.findByRole("switch", { name: title });

			// The name is not a `title` tooltip that jsdom's accname fell back to.
			expect(sw).not.toHaveAttribute("title");
			// ...it is the visible heading, pointed at rather than retyped.
			const targets = labelledBy(sw);
			expect(targets).toHaveLength(1);
			expect(targets[0]).toBeInTheDocument();
			expect(targets[0].textContent?.trim()).toBe(title);
			// The sentence under it is the DESCRIPTION. A whole sentence read out as a control's
			// name is not a name, so it must not be a second `aria-labelledby` id.
			expect(sw).toHaveAccessibleDescription(descPattern);
		},
	);

	it("gives the three gates three distinct label ids rather than one colliding string", async () => {
		renderDrawer();
		await screen.findByRole("switch", { name: "Require predecessor" });
		const ids = screen
			.getAllByRole("switch")
			.map((s) => s.getAttribute("aria-labelledby"));
		expect(ids).toHaveLength(3);
		// A hardcoded id would make all three point at the FIRST row's title — a drawer that
		// announces "Require predecessor" three times reads as named and is not.
		expect(new Set(ids).size).toBe(3);
	});

	it("names the two number gates the same way, so one drawer names its controls one way", async () => {
		renderDrawer();
		for (const title of ["Soak timer (min)", "Cost threshold ($/mo)"]) {
			const input = await screen.findByRole("spinbutton", { name: title });
			expect(input).not.toHaveAttribute("title");
			expect(labelledBy(input)[0]?.textContent?.trim()).toBe(title);
		}
	});

	it("leaves no unnamed control in the open drawer, including the approvals count", async () => {
		const user = userEvent.setup();
		renderDrawer();
		// "Approvals required" only mounts once the approval gate is on — a control the sweep
		// would otherwise never render is invisible to it forever, which is how this class of
		// defect survives a route-level audit in the first place.
		await user.click(await screen.findByRole("switch", { name: "Require approval" }));
		await screen.findByRole("spinbutton", { name: "Approvals required" });

		// The subtraction above is only honest while it still has a subject. If base-ui stops
		// rendering focus guards (or stops sniffing jsdom as Safari), this must fail rather than
		// quietly become a `:not()` that excludes nothing while still claiming to.
		expect(
			document.querySelectorAll("[data-base-ui-focus-guard]").length,
		).toBeGreaterThan(0);
		expect(unnamedControls(document.body, OWN_NAMED_CONTROLS)).toEqual([]);
	});
});

describe("PromoteDialog — the source/target pickers and the removals opt-in are named", () => {
	function renderDialog() {
		return render(
			<PromoteDialog
				open
				onOpenChange={() => {}}
				projectId="p1"
				envs={ENVS}
				onPromoted={() => {}}
			/>,
		);
	}

	it.each([["From"], ["To"]])(
		"names the %s picker from its visible label, which a combobox never takes from contents",
		async (label) => {
			renderDialog();
			const trigger = await screen.findByRole("combobox", { name: label });
			expect(trigger).not.toHaveAttribute("title");
			expect(labelledBy(trigger)[0]?.textContent?.trim()).toBe(label);
		},
	);

	it("names the destructive removals opt-in, and keeps its warning as a description", async () => {
		const user = userEvent.setup();
		renderDialog();

		// The opt-in mounts only once a source/target pair yields a diff carrying a DELETE, so the
		// pair has to be driven — it is exactly the control an audit at page load cannot reach.
		await user.click(await screen.findByRole("combobox", { name: "From" }));
		await user.click(await screen.findByRole("option", { name: "development" }));
		await user.click(await screen.findByRole("combobox", { name: "To" }));
		await user.click(await screen.findByRole("option", { name: "production" }));

		const sw = await screen.findByRole("switch", { name: "Apply removals" });
		expect(sw).not.toHaveAttribute("title");
		expect(labelledBy(sw)[0]?.textContent?.trim()).toBe("Apply removals");
		// "(destructive)" is what the user needs after the name, not inside it.
		expect(sw).toHaveAccessibleDescription(/destructive/i);
	});
});

describe("NewEnvironmentDialog — the duplicate base picker is named", () => {
	it("names the base picker from the label above it", async () => {
		render(
			<NewEnvironmentDialog
				open
				onOpenChange={() => {}}
				projectId="p1"
				envs={ENVS.map((e) => ({
					...e,
					project_id: "p1",
					is_default: e.id === "env-dev",
				}))}
				onCreated={() => {}}
			/>,
		);

		const trigger = await screen.findByRole("combobox", {
			name: "Base environment",
		});
		expect(trigger).not.toHaveAttribute("title");
		expect(labelledBy(trigger)[0]?.textContent?.trim()).toBe("Base environment");

		// The name field is a real `<input>` under a real `<label htmlFor>` — the association that
		// DOES work — and is here so the dialog's sweep covers both mechanisms at once.
		await waitFor(() =>
			expect(
				within(document.body).getByRole("textbox", { name: /environment name/i }),
			).toBeInTheDocument(),
		);
	});
});
