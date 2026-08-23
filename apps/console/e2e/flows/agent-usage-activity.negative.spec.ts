// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E (negatives / gating / empty-state) for the insights surfaces — the paths that a plan boundary,
// an unmatched filter, or an invalid input should block or narrow:
//   • Activity CSV export is Enterprise-only → disabled on Hobby AND Pro (non-enterprise).
//   • Activity time windows older than the plan's retention prompt an upgrade instead of applying.
//   • An unmatched search lands the feed on its empty state.
//   • The project-scoped feed drops the org-only affordances (Export CSV + the Project facet).
//   • The account dialog validates the display name (empty → error, no persist).
//
// Personas: `owner` = Hobby (community, 7-day activity retention), `team` = Pro (30-day retention).

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
			owner.page.getByRole("button", { name: /last 7 days/i }),
		).toBeVisible({ timeout: 30_000 });

		await owner.page.getByRole("button", { name: /last 7 days/i }).click();
		await owner.page.getByRole("button", { name: "Last 30 days", exact: true }).click();

		// The pick predates Hobby's 7-day retention → the upgrade sheet intercepts.
		await expect(owner.page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
		// The trigger label stays put (the range was NOT applied).
		await expect(
			owner.page.getByRole("button", { name: /last 7 days/i }),
		).toBeVisible();
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
test.describe("Account settings — validation (owner)", () => {
	test("clearing the display name surfaces a validation error", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /account menu/i }).click();
		await owner.page.getByRole("button", { name: /account settings/i }).click();

		const dialog = owner.page.getByRole("dialog");
		const name = dialog.getByLabel(/display name/i);
		await expect(name).toBeVisible({ timeout: 15_000 });
		await name.fill(""); // making it empty also marks the form dirty → Save enables
		await dialog.getByRole("button", { name: /save changes/i }).click();

		await expect(dialog.getByText(/enter a display name/i)).toBeVisible();
	});
});
