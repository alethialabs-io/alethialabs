// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E (negatives / gating / empty-state) for the insights surfaces — the paths that a plan boundary,
// an unmatched filter, or an invalid input should block or narrow:
//   • Activity CSV export is Enterprise-only → disabled on Hobby AND Pro (non-enterprise).
//   • Activity time windows older than the plan's retention prompt an upgrade INSTEAD of applying —
//     and the filters must be provably untouched, which is a question for the URL, not the screen.
//   • An unmatched search lands the feed on its empty state.
//   • The project-scoped feed drops the org-only affordances (Export CSV + the Project facet).
//   • The account dialog: Save is inert until something changes, and an over-long name is refused.
//
// Personas: `owner` = Hobby (community, 7-day activity retention), `team` = Pro (30-day retention)
// — `apps/console/lib/billing/plan.ts`, `activityRetentionDays`.

import fs from "node:fs";
import { seedProject } from "../helpers/seed";
import { personaMetaPath, type PersonaRecord } from "../helpers/personas";
import { expect, test } from "../fixtures/qa";

const usagePath = (slug: string) => `/${slug}/~/usage`;
const activityPath = (slug: string) => `/${slug}/~/settings/activity`;

test.beforeEach(() => {
	test.setTimeout(120_000);
});

// ── Activity — export gating (Enterprise-only) ──────────────────────────────────────────────
test.describe("Activity — CSV export gating", () => {
	test("Hobby org sees the Export CSV control disabled", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		const exportBtn = owner.page.getByRole("button", { name: /export csv/i });
		await expect(exportBtn).toBeVisible({ timeout: 30_000 });
		await expect(exportBtn).toBeDisabled();
	});

	test("Hobby Export CSV carries the Enterprise-upgrade hint", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		const exportBtn = owner.page.getByRole("button", { name: /export csv/i });
		await expect(exportBtn).toBeVisible({ timeout: 30_000 });
		await expect(exportBtn).toHaveAttribute("title", /enterprise plan/i);
	});

	test("Pro (non-Enterprise) org also sees Export CSV disabled", async ({ team }) => {
		await team.page.goto(activityPath(team.orgSlug));
		const exportBtn = team.page.getByRole("button", { name: /export csv/i });
		await expect(exportBtn).toBeVisible({ timeout: 30_000 });
		await expect(exportBtn).toBeDisabled();
	});
});

// ── Activity — retention gating ─────────────────────────────────────────────────────────────
test.describe("Activity — retention window gating (Hobby)", () => {
	test("picking a range older than 7-day retention opens the upgrade sheet, not the range", async ({
		owner,
	}) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await expect(
			owner.page.getByRole("button", { name: /^Last 7 days$/i }),
		).toBeVisible({ timeout: 30_000 });

		// Captured while the filters are provably pristine, so the assertion at the end can be
		// an EQUALITY rather than a list of keys someone has to remember to extend.
		const pristineUrl = owner.page.url();

		await owner.page.getByRole("button", { name: /^Last 7 days$/i }).click();
		await owner.page.getByRole("button", { name: "Last 30 days", exact: true }).click();

		// The pick predates Hobby's 7-day retention → `applyRange` opens the upgrade sheet and
		// returns WITHOUT patching the store (activity-log.tsx).
		await expect(owner.page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });

		// WHY THE ASSERTION IS THE TRIGGER'S LABEL AND NOT A NEGATED `toHaveURL` (#4619 review).
		//
		// A web assertion — negated or not — retries until it holds and RETURNS ON THE FIRST
		// PASSING POLL. The window starts with no `rangeLabel`/`from` in it, so
		// `not.toHaveURL(/rangeLabel=/)` passed on its first evaluation whether or not the range
		// was applied: had `applyRange` regressed to `patch({…}); setUpgradeOpen(true)`, the URL
		// would only change AFTERWARDS, through `useFilterUrlSync`'s effect → `router.replace()`
		// → a soft navigation, a few frames past the assertion that had already returned. The
		// pair could not fail, which is the whole of what it was for.
		//
		// The trigger's label has no such window. It is rendered straight from the filter
		// store's `rangeLabel`, and `patch` + `setUpgradeOpen(true)` would be batched into ONE
		// React commit — so the sheet BEING VISIBLE, asserted above, already proves the label has
		// been re-rendered from whatever the store now holds. There is no "not yet" state to be
		// satisfied by.
		//
		// It is read with a CSS locator on purpose. The sheet is a modal, so the page behind it
		// leaves the accessibility tree and `getByRole` resolves to nothing there — which is why
		// the ORIGINAL label assertion was recorded `failed` on a page where nothing was wrong.
		// `locator("button")` + `hasText` is a DOM query, not an a11y one, and `toHaveText` does
		// not require visibility, so neither is affected by `aria-hidden`.
		//
		// The filter is deliberately loose and the ASSERTION is what is exact: `hasText` must
		// still select the trigger after a regression has relabelled it, or the test would fail
		// by finding nothing and say the wrong thing about why. `.first()` is the quick-range
		// trigger — the only other range control in the bar, `DateRangeFilter`, labels itself
		// with formatted dates (`formatRangeLabel`), never "Last N days".
		const rangeTrigger = owner.page
			.locator("button")
			.filter({ hasText: /Last \d+ days/ })
			.first();
		await expect(rangeTrigger).toHaveText("Last 7 days");

		// And the URL exactly, as a second, independent half: a rejected pick writes no key and
		// `useFilterUrlSync` deletes every default-valued one, so a pristine window is the path
		// with no query string at all. Equality fails on ANY key a regression might add, not only
		// the two this test happened to name.
		await expect(owner.page).toHaveURL(pristineUrl);
	});
});

// ── Activity — empty state ──────────────────────────────────────────────────────────────────
test.describe("Activity — empty state (owner)", () => {
	test("an unmatched search narrows the feed to its empty state", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		const search = owner.page.getByPlaceholder(/search actor, action or resource/i);
		await expect(search).toBeVisible({ timeout: 30_000 });
		// A unique token no seeded row can contain → server refetch returns nothing.
		await search.fill(`zzz-nomatch-${Date.now()}`);
		await expect(
			owner.page.getByText(/no activity matches these filters/i),
		).toBeVisible({ timeout: 30_000 });
	});
});

// ── Activity — project-scoped feed ──────────────────────────────────────────────────────────
test.describe("Activity — project scope drops org-only affordances (owner)", () => {
	let projectSlug: string;

	test.beforeAll(async () => {
		// Seed a project the persona owns so the project-scoped activity route resolves.
		const meta = JSON.parse(fs.readFileSync(personaMetaPath(), "utf8")) as Record<
			string,
			PersonaRecord
		>;
		const rec = meta.ownerHobby;
		// userId/orgId are resolved from the DB during global-setup and are optional on the record.
		// Fail loudly here rather than seeding against `undefined` and reading the miss as an
		// empty-state assertion passing.
		if (!rec?.userId || !rec.orgId) throw new Error("ownerHobby persona has no userId/orgId — global-setup did not complete");
		const project = await seedProject(
			{ userId: rec.userId, orgId: rec.orgId },
			{ name: `e2e-activity-${Date.now()}` },
		);
		projectSlug = project.slug;
	});

	test("the pinned feed hides Export CSV and the Project facet", async ({ owner }) => {
		test.skip(!projectSlug, "project seed failed");
		await owner.page.goto(`/${owner.orgSlug}/${projectSlug}/settings/activity`);
		// The reusable filter bar still renders (search present)…
		await expect(
			owner.page.getByPlaceholder(/search actor, action or resource/i),
		).toBeVisible({ timeout: 30_000 });
		// …but the org-only Export + Project facet are gone when pinned to a project.
		await expect(owner.page.getByRole("button", { name: /export csv/i })).toHaveCount(0);
		await expect(owner.page.getByRole("button", { name: /^project$/i })).toHaveCount(0);
	});

	test("the pinned feed labels the project scope", async ({ owner }) => {
		test.skip(!projectSlug, "project seed failed");
		await owner.page.goto(`/${owner.orgSlug}/${projectSlug}/settings/activity`);
		await expect(owner.page.getByText(/^Activity in/i)).toBeVisible({ timeout: 30_000 });
	});
});

// ── Account settings — display-name validation ──────────────────────────────────────────────
//
// WHAT IS NOT HERE, AND WHY. "Clearing the display name surfaces a validation error" was recorded
// `failed`, and rewriting it would not have fixed it: `Save Changes` is `disabled={!isDirty}` and
// the form is built with react-hook-form `values: { name: user?.name ?? "" }`, so for a persona
// whose display name is ALREADY empty, clearing the field returns the form to its own defaults —
// not dirty, Save inert, no submit, no error. The `min(1)` branch is unreachable from that
// starting state, which is correct behaviour, and a test that waits for a disabled button to
// enable can only time out. Measuring it needs a persona with a display name, which global-setup's
// OTP signup does not set; that is a seeding change, and this lane does not own `global-setup.ts`.
// So this describe measures the two rules that ARE reachable from any starting state.
test.describe("Account settings — validation (owner)", () => {
	test("Save Changes is inert until the profile actually changes", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /account menu/i }).click();
		await owner.page.getByRole("button", { name: /account settings/i }).click();

		const dialog = owner.page.getByRole("dialog");
		const name = dialog.getByLabel(/display name/i);
		const save = dialog.getByRole("button", { name: /save changes/i });
		await expect(name).toBeVisible({ timeout: 15_000 });

		await expect(save).toBeDisabled();
		await name.fill(`QA probe ${Date.now()}`);
		// Enabling is what the edit uniquely produces — a control that never enables and one that
		// is always enabled both fail here, which is why both halves are asserted.
		await expect(save).toBeEnabled();
	});

	test("a display name past the 120-character limit is refused", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /account menu/i }).click();
		await owner.page.getByRole("button", { name: /account settings/i }).click();

		const dialog = owner.page.getByRole("dialog");
		const name = dialog.getByLabel(/display name/i);
		await expect(name).toBeVisible({ timeout: 15_000 });

		// 121 characters — one past `profileSchema`'s `.max(120)`. Reachable from ANY starting
		// value, unlike the empty-name branch: it differs from every default, so the form is
		// dirty and Save submits.
		await name.fill("q".repeat(121));
		await dialog.getByRole("button", { name: /save changes/i }).click();

		// The message is zod's own for `max`, and its wording has changed between zod majors, so
		// the LIMIT is what is asserted — the number the schema states — rather than a sentence
		// this test would own a copy of.
		await expect(dialog.getByText(/120/)).toBeVisible();
	});
});
