// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Deploy-jobs domain — negative / empty-state / edge paths, rewritten against today's console
// (#4274): a missing job id, the clusters empty state for an undeployed project, the two DIFFERENT
// things a short environment list says, and the two form reveals on the promotion gates.
//
// EMPTY-STATE COPY IS THE ASSERTION HERE, not scenery. Three of this domain's surfaces have two
// empty states that differ only in words — "no clusters yet" vs "this fetch failed", "no jobs yet"
// vs "no jobs match", "no environments" vs "only one environment" — and picking the wrong one tells
// the user their data is gone. A test that matched either would not be measuring anything.
//
// Everything is scoped to uniquely-named seeded rows (the persona org is shared and parallel).

import { test, expect } from "../fixtures/qa";
import type { Owner } from "../helpers/seed";
import { seedCloudIdentity, seedProject, type SeededProject } from "../helpers/seed";

/** Navigate without waiting for the full `load` event (slow QA SSR / open SSE streams). */
async function visit(page: import("@playwright/test").Page, path: string) {
	await page.goto(path, { waitUntil: "domcontentloaded" });
}

let ownerId: Owner;
let singleEnvProject: SeededProject; // DRAFT project, no finished deploy → no clusters, 1 env

test.beforeAll(async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const meta = JSON.parse(
		fs.readFileSync(path.resolve(process.cwd(), "e2e/.auth/personas.json"), "utf8"),
	);
	ownerId = { userId: meta.ownerHobby.userId, orgId: meta.ownerHobby.orgId };
	const identity = await seedCloudIdentity(ownerId, { provider: "aws" });
	singleEnvProject = await seedProject(ownerId, {
		name: `e2e-deployjobs-neg-${Date.now()}`,
		cloudIdentityId: identity.id,
		status: "DRAFT",
	});
});

// The QA dev server SSR is slow under parallel load, and Next cold-compiles routes on first hit;
// give each test generous headroom.
test.beforeEach(() => {
	test.setTimeout(180_000);
});

test.describe("Deploy jobs — negative & empty states", () => {
	test("a non-existent job id renders the not-found state with a way back", async ({ owner }) => {
		// A well-formed but unseeded uuid.
		const ghost = "00000000-0000-4000-8000-000000000000";
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${ghost}`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// A real heading, not a bare paragraph: this is `EmptyState level={2}`, so a reader moving
		// by heading lands on the thing that went wrong.
		await expect(
			owner.page.getByRole("heading", { name: "Job not found." }),
		).toBeVisible({ timeout: 25_000 });
		// An empty state with nowhere to go from it is the defect the shared component replaced.
		await expect(owner.page.getByRole("link", { name: "Back to jobs" })).toBeVisible();
	});

	test("an undeployed project shows the clusters empty state", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/clusters`);
		await expect(owner.page.getByText("No clusters provisioned")).toBeVisible({
			timeout: 25_000,
		});
		await expect(
			owner.page.getByText(/Clusters appear here once a project deploys its first environment/i),
		).toBeVisible();
		// The OTHER state this surface can render. A fetch failure that fell through to "no
		// clusters provisioned" would tell the user their infrastructure vanished.
		await expect(owner.page.getByText("Couldn't load clusters")).toHaveCount(0);
	});

	test("a single-environment project hides Promote and says why, without claiming to be empty", async ({
		owner,
	}) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/environments`);
		await expect(
			owner.page.getByRole("heading", { name: /^Environments/ }),
		).toBeVisible({ timeout: 25_000 });
		// Promote only appears when envs.length > 1.
		await expect(owner.page.getByRole("button", { name: /^Promote$/i })).toHaveCount(0);
		// But New Environment is always available — a one-environment project is exactly the one
		// that needs it.
		await expect(owner.page.getByRole("button", { name: /New Environment/i })).toBeVisible();
		// The note under a POPULATED list, not the empty state. The predicate behind these two used
		// to be `<= 1`, which asserted "Only one environment" over none at all.
		await expect(owner.page.getByText(/Only one environment/)).toBeVisible();
		await expect(owner.page.getByText("No environments", { exact: true })).toHaveCount(0);
	});

	test("the New Environment dialog refuses an empty name", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/environments`);
		await owner.page.getByRole("button", { name: /New Environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		await dialog.getByRole("button", { name: "Create environment" }).click();
		// The old assertion here was `if (await submit.count()) { … }` — a test that passed by
		// doing nothing whenever the button's name changed. This one names the validation.
		await expect(owner.page.getByText("Environment name is required")).toBeVisible({
			timeout: 10_000,
		});
		await expect(dialog).toBeVisible();
	});

	test("toggling 'Require approval' reveals the approvals-required input", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/environments`);
		await owner.page.getByRole("button", { name: "Edit rules" }).first().click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet).toBeVisible({ timeout: 15_000 });
		// The min-count input is hidden until require-approval is on.
		await expect(sheet.getByText("Approvals required")).toHaveCount(0);
		// Each gate is a `<label>` wrapping its text and its Switch, so the switch takes its
		// accessible name from the gate — no structural xpath needed to reach it.
		await sheet.getByRole("switch", { name: /Require approval/ }).click();
		await expect(sheet.getByText("Approvals required")).toBeVisible();
	});

	test("the gates drawer offers the two numeric gates as off-by-default", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/environments`);
		await owner.page.getByRole("button", { name: "Edit rules" }).first().click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet).toBeVisible({ timeout: 15_000 });
		// Blank = null = off, which is why the placeholder says so rather than showing a 0 that
		// would read as "wait zero minutes" — a real instruction, not an absent one.
		await expect(sheet.getByText("Soak timer (min)")).toBeVisible();
		await expect(sheet.getByText("Cost threshold ($/mo)")).toBeVisible();
		await expect(sheet.getByPlaceholder("off")).toHaveCount(2);
	});
});
