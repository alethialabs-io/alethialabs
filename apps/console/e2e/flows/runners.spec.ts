// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runners domain — the org-scoped Runners/Fleet page (/${org}/~/runners).
//
// Deployment note: this QA console runs in HOSTED mode. The runner surface is gated behind the
// `byoRunners` entitlement (Pro+), so ALL interactive runner tests use the `team` persona (Pro
// card-less trial → byoRunners=true). The Hobby `owner` persona is intentionally gated and is
// exercised in runners.negative.spec.ts. In hosted mode managed fleet runners are hidden from
// tenants and the left-column Pools section is not rendered, so the team org's baseline is 0
// runners → a deterministic empty state.
//
// Isolation: the team org has no real runners, so every test seeds/creates uniquely-named
// `e2e-*` runners and afterEach removes them by name prefix (never touches sibling data).

import { test, expect } from "../fixtures/qa";
import { db } from "../helpers/db";

// The runners route is a cold-compiled Next dev bundle on first hit (navigation p95 ≈ 25s), so the
// default 30s test budget is too tight for the multi-navigation flows. Give every test headroom.
test.describe.configure({ timeout: 90_000 });

/** Retries a DB write on transient Postgres deadlocks (40P01) — the shared QA DB has a live runner
 *  heartbeating on the `runners` table, so seed/purge writes can occasionally deadlock with it. */
async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code === "40P01" && attempt < 4) {
				await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
				continue;
			}
			throw err;
		}
	}
}

/** Seeds a self-operated runner directly (RLS-bypassing owner role); sets both user_id + org_id
 *  so the app's RLS-scoped queries surface it. Registered runners show a Remove action; deployed
 *  ones (with a cloud identity + deploy_config) show Destroy. */
async function seedRunner(
	teamUserId: string,
	teamOrgId: string,
	opts: {
		name: string;
		provisioning?: "registered" | "deployed";
		status?: string;
		cloudIdentityId?: string | null;
		version?: string | null;
		isDefault?: boolean;
	},
): Promise<{ id: string }> {
	const sql = db();
	const provisioning = opts.provisioning ?? "registered";
	const deployConfig =
		provisioning === "deployed"
			? sql.json({
					deploy_config: {
						region: "eu-central-1",
						cloud_provider: "aws",
						image_tag: "latest",
					},
				})
			: sql.json({});
	const [row] = await withDeadlockRetry(
		() => sql<{ id: string }[]>`
			insert into runners ${sql({
				user_id: teamUserId,
				org_id: teamOrgId,
				name: opts.name,
				operator: "self",
				provisioning,
				token_hash: `e2e-hash-${Math.random().toString(36).slice(2)}`,
				status: opts.status ?? "OFFLINE",
				cloud_identity_id: opts.cloudIdentityId ?? null,
				version: opts.version ?? null,
				is_default: opts.isDefault ?? false,
				metadata: deployConfig,
			})}
			returning id`,
	);
	return row;
}

/** Removes every e2e-prefixed runner for the team user — the per-test isolation sweep. */
async function purgeE2ERunners(teamUserId: string): Promise<void> {
	const sql = db();
	await withDeadlockRetry(
		() => sql`delete from runners where user_id = ${teamUserId} and name like 'e2e-%'`,
	);
}

const RUNNERS_PATH = (slug: string) => `/${slug}/~/runners`;

test.describe("Runners — page & entitlement", () => {
	test.afterEach(async ({ team }) => {
		await purgeE2ERunners(team.userId!);
	});

	test("Pro org loads the runner surface without bouncing to /login", async ({ team }) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		// The runner surface (not the upsell) — the Add runner CTA is present for Pro.
		await expect(team.page.getByRole("button", { name: "Add runner" }).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("renders the Versions panel with an empty-releases state", async ({ team }) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(team.page.getByText("Versions", { exact: true })).toBeVisible({ timeout: 15_000 });
		// No runner releases seeded on this deployment.
		await expect(team.page.getByText("No runner releases yet.")).toBeVisible();
	});

	test("shows the empty-runners first-run state when the org has no runners", async ({ team }) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(team.page.getByRole("heading", { name: "No runners yet" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(
			team.page.getByText(/Runners execute provisioning jobs\./),
		).toBeVisible();
	});

	test("the grid renders one card per runner in the org", async ({ team }) => {
		const stamp = Date.now();
		await seedRunner(team.userId!, team.orgId!, { name: `e2e-count-a-${stamp}` });
		await seedRunner(team.userId!, team.orgId!, { name: `e2e-count-b-${stamp}` });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		// Both seeded runners surface as their own cards.
		await expect(
			team.page.locator('[data-slot="card"]').filter({ hasText: `e2e-count-a-${stamp}` }),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			team.page.locator('[data-slot="card"]').filter({ hasText: `e2e-count-b-${stamp}` }),
		).toBeVisible();
	});
});

test.describe("Runners — Add runner sheet", () => {
	test.afterEach(async ({ team }) => {
		await purgeE2ERunners(team.userId!);
	});

	test("opens to a path chooser with Deploy + Register options and a managed-pools hint", async ({
		team,
	}) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Add runner" }).first().click();
		await expect(team.page.getByText("Add a runner")).toBeVisible();
		await expect(team.page.getByRole("button", { name: /Deploy to a cloud/ })).toBeVisible();
		await expect(team.page.getByRole("button", { name: /Register your own/ })).toBeVisible();
		await expect(team.page.getByText(/Managed runners/).first()).toBeVisible();
	});

	test("Register sub-view exposes a name field and a Back button to the chooser", async ({
		team,
	}) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Add runner" }).first().click();
		await team.page.getByRole("button", { name: /Register your own/ }).click();
		await expect(team.page.getByPlaceholder("e.g. fargate-eu-west-1")).toBeVisible();
		// Back returns to the chooser (both path cards visible again).
		await team.page.getByRole("button", { name: "Back" }).click();
		await expect(team.page.getByRole("button", { name: /Deploy to a cloud/ })).toBeVisible();
	});

	test("Register button is disabled until a valid (non-empty, non-whitespace) name is entered", async ({
		team,
	}) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Add runner" }).first().click();
		await team.page.getByRole("button", { name: /Register your own/ }).click();
		const submit = team.page.getByRole("button", { name: "Register runner" });
		await expect(submit).toBeDisabled();
		// Whitespace-only trims to empty → still invalid.
		await team.page.getByPlaceholder("e.g. fargate-eu-west-1").fill("   ");
		await expect(submit).toBeDisabled();
		// A real name enables it.
		await team.page.getByPlaceholder("e.g. fargate-eu-west-1").fill(`e2e-valid-${Date.now()}`);
		await expect(submit).toBeEnabled();
	});

	test("registering a runner reveals a one-time token that cannot be recovered", async ({
		team,
	}) => {
		const name = `e2e-reg-${Date.now()}`;
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Add runner" }).first().click();
		await team.page.getByRole("button", { name: /Register your own/ }).click();
		await team.page.getByPlaceholder("e.g. fargate-eu-west-1").fill(name);
		await team.page.getByRole("button", { name: "Register runner" }).click();

		// Token-reveal panel: warning copy + Runner ID + Runner Token + the start snippet.
		await expect(team.page.getByText("Save these credentials now")).toBeVisible({ timeout: 15_000 });
		await expect(team.page.getByText("Runner ID", { exact: true })).toBeVisible();
		await expect(team.page.getByText("Runner Token", { exact: true })).toBeVisible();
		await expect(team.page.getByText(/alethia runner start/)).toBeVisible();
		await expect(team.page.getByRole("button", { name: "Done" })).toBeVisible();
	});

	test("a registered runner appears in the grid after the sheet closes", async ({ team }) => {
		const name = `e2e-appears-${Date.now()}`;
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Add runner" }).first().click();
		await team.page.getByRole("button", { name: /Register your own/ }).click();
		await team.page.getByPlaceholder("e.g. fargate-eu-west-1").fill(name);
		await team.page.getByRole("button", { name: "Register runner" }).click();
		await team.page.getByRole("button", { name: "Done" }).click();

		// The new runner shows as a card. router.refresh() during register updates the list.
		await expect(
			team.page.locator('[data-slot="card"]').filter({ hasText: name }),
		).toBeVisible({ timeout: 15_000 });
	});

	test("Deploy sub-view renders its deploy description (form or connect-a-cloud state)", async ({
		team,
	}) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Add runner" }).first().click();
		await team.page.getByRole("button", { name: /Deploy to a cloud/ }).click();
		// Deterministic regardless of whether a cloud is connected: the sheet description.
		await expect(
			team.page.getByText(/Provision a runner into your cloud account/),
		).toBeVisible();
	});
});

test.describe("Runners — lifecycle actions", () => {
	test.afterEach(async ({ team }) => {
		await purgeE2ERunners(team.userId!);
	});

	test("toggling the default star marks a runner as default", async ({ team }) => {
		const name = `e2e-default-${Date.now()}`;
		const seeded = await seedRunner(team.userId!, team.orgId!, { name });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = team.page.locator('[data-slot="card"]').filter({ hasText: name });
		await expect(card).toBeVisible({ timeout: 15_000 });
		// The star is the first (icon-only) button in the card's action row — see testid-gap finding.
		await card.getByRole("button").first().click();
		// Assert the persisted outcome (the toast is transient / unreliable to await).
		await expect
			.poll(
				async () => {
					const rows = await db()<{ is_default: boolean }[]>`
						select is_default from runners where id = ${seeded.id}`;
					return rows[0]?.is_default ?? null;
				},
				{ timeout: 10_000 },
			)
			.toBe(true);
	});

	test("removing a registered runner confirms via dialog and drops it from the grid", async ({
		team,
	}) => {
		const name = `e2e-remove-${Date.now()}`;
		const seeded = await seedRunner(team.userId!, team.orgId!, { name });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = team.page.locator('[data-slot="card"]').filter({ hasText: name });
		await expect(card).toBeVisible({ timeout: 15_000 });

		await card.getByRole("button", { name: "Remove" }).click();
		// AlertDialog confirmation.
		await expect(team.page.getByRole("alertdialog")).toBeVisible();
		await expect(team.page.getByText(new RegExp(`Remove runner .*${name}`))).toBeVisible();
		await team.page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();

		// The card leaves the grid and the row is gone from the DB.
		await expect(card).toHaveCount(0, { timeout: 15_000 });
		await expect
			.poll(
				async () => {
					const rows = await db()<{ id: string }[]>`
						select id from runners where id = ${seeded.id}`;
					return rows.length;
				},
				{ timeout: 10_000 },
			)
			.toBe(0);
	});

	test("the remove confirmation can be cancelled, leaving the runner in place", async ({ team }) => {
		const name = `e2e-cancel-${Date.now()}`;
		await seedRunner(team.userId!, team.orgId!, { name });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = team.page.locator('[data-slot="card"]').filter({ hasText: name });
		await expect(card).toBeVisible({ timeout: 15_000 });

		await card.getByRole("button", { name: "Remove" }).click();
		await team.page.getByRole("button", { name: "Cancel" }).click();
		await expect(team.page.getByRole("alertdialog")).toHaveCount(0);
		await expect(card).toBeVisible();
	});
});

test.describe("Runners — search & filters", () => {
	test.afterEach(async ({ team }) => {
		await purgeE2ERunners(team.userId!);
	});

	test("search narrows the grid to the matching runner", async ({ team }) => {
		const stamp = Date.now();
		const alpha = `e2e-alpha-${stamp}`;
		const bravo = `e2e-bravo-${stamp}`;
		await seedRunner(team.userId!, team.orgId!, { name: alpha });
		await seedRunner(team.userId!, team.orgId!, { name: bravo });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(
			team.page.locator('[data-slot="card"]').filter({ hasText: alpha }),
		).toBeVisible({ timeout: 15_000 });

		await team.page.getByPlaceholder("Search runners by name…").fill("alpha");
		await expect(team.page.locator('[data-slot="card"]').filter({ hasText: alpha })).toBeVisible();
		await expect(team.page.locator('[data-slot="card"]').filter({ hasText: bravo })).toHaveCount(0);
	});

	test("a non-matching search shows the 'no runners match' message", async ({ team }) => {
		await seedRunner(team.userId!, team.orgId!, { name: `e2e-filtermiss-${Date.now()}` });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByPlaceholder("Search runners by name…").fill("zzz-nonexistent-xyz");
		await expect(team.page.getByText("No runners match your filters.")).toBeVisible({
			timeout: 10_000,
		});
	});

	test("the filters popover exposes status and operator chip groups", async ({ team }) => {
		await seedRunner(team.userId!, team.orgId!, { name: `e2e-facets-${Date.now()}` });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Filters" }).click();
		await expect(team.page.getByText("Status", { exact: true })).toBeVisible();
		await expect(team.page.getByText("Operator", { exact: true })).toBeVisible();
		// Status chips are actionable.
		await expect(team.page.getByRole("button", { name: "Online", exact: true })).toBeVisible();
	});
});
