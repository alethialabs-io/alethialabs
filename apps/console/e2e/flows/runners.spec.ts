// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runners domain — the org-scoped Runners/Fleet page (/${org}/~/runners).
//
// DEPLOYMENT MODE IS THE FIRST THING TO KNOW HERE, because two whole surfaces hang off it and the
// previous version of this header got it backwards. `deploymentMode()` reads
// `ALETHIA_DEPLOYMENT_MODE` and answers "self-managed" for anything that is not the literal
// "hosted" (lib/billing/config.ts). The release gate NEVER sets it — `.github/workflows/release-gate.yml`
// says why in so many words ("NEVER `ALETHIA_DEPLOYMENT_MODE=hosted` here — packages/email then
// refuses the OTP log fallback and nothing can sign in"). So on the leg that measures this file the
// console is SELF-MANAGED, and therefore:
//
//   · the byoRunners entitlement gate is INERT. `runners-client.tsx` renders `<FeatureUpsell>` only
//     when `isHosted && !canByoRunners`, so the Hobby persona is not gated — see runners.negative.spec.ts.
//   · the warm-Pools column IS rendered (`{!isHosted && …}`) and `getFleetPoolViews()` returns rows,
//     so `PoolCard` and its delete confirmation are reachable. On hosted they are not.
//
// Isolation: the team org's runners are seeded per test with an `e2e-` prefix and swept in
// `afterEach` by that prefix, never by emptying the org (AUTHORING.md's fullyParallel rule). The
// warm pool is the one exception — it is a GLOBAL platform row, seeded once and left in place; see
// `seedFleetPool`'s contract in helpers/seed-runners.ts.

import { test, expect } from "../fixtures/qa";
import {
	purgeE2ERunners,
	runnerIsDefault,
	runnerExists,
	seedFleetPool,
	seedRunner,
	type SeededFleetPool,
} from "../helpers/seed-runners";

// The runners route is a cold-compiled bundle on first hit (navigation p95 ≈ 25s), so the default
// 30s test budget is too tight for the multi-navigation flows. Give every test headroom.
test.describe.configure({ timeout: 90_000 });

const RUNNERS_PATH = (slug: string) => `/${slug}/~/runners`;

/** A runner card, located by the name printed in its header. */
const cardFor = (page: import("@playwright/test").Page, name: string) =>
	page.locator('[data-slot="card"]').filter({ hasText: name });

test.describe("Runners — page & entitlement", () => {
	test.afterEach(async ({ team }) => {
		await purgeE2ERunners(team.userId!);
	});

	test("Pro org loads the runner surface without bouncing to /login", async ({ team }) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		// The runner surface (not the upsell) — the Add runner CTA is present.
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
		await expect(team.page.getByText(/Runners execute provisioning jobs\./)).toBeVisible();
	});

	test("the grid renders one card per runner in the org", async ({ team }) => {
		const stamp = Date.now();
		const id = { userId: team.userId!, orgId: team.orgId! };
		await seedRunner(id, { name: `e2e-count-a-${stamp}` });
		await seedRunner(id, { name: `e2e-count-b-${stamp}` });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		// Both seeded runners surface as their own cards.
		await expect(cardFor(team.page, `e2e-count-a-${stamp}`)).toBeVisible({ timeout: 15_000 });
		await expect(cardFor(team.page, `e2e-count-b-${stamp}`)).toBeVisible();
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

		// The new runner shows as a card — the mutation invalidates the runners query.
		await expect(cardFor(team.page, name)).toBeVisible({ timeout: 15_000 });
	});

	test("Deploy sub-view names the clouds a runner can actually be deployed into", async ({
		team,
	}) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByRole("button", { name: "Add runner" }).first().click();
		await team.page.getByRole("button", { name: /Deploy to a cloud/ }).click();
		// The sheet description is DERIVED from RUNNER_DEPLOY_PROVIDERS_LABEL
		// (lib/runners/deploy-providers.ts), so the assertion is written against the sentence's
		// SHAPE rather than today's one-cloud list — adding GCP to that array must not turn this
		// red. The old spec pinned the literal "your cloud account", which the derived copy has
		// never said, and it had been failing on that ever since.
		await expect(
			team.page.getByText(/Provision a runner into your .+ account/),
		).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Runners — lifecycle actions", () => {
	test.afterEach(async ({ team }) => {
		await purgeE2ERunners(team.userId!);
	});

	test("toggling the default star marks a runner as default", async ({ team }) => {
		const name = `e2e-default-${Date.now()}`;
		const seeded = await seedRunner(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name },
		);
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = cardFor(team.page, name);
		await expect(card).toBeVisible({ timeout: 15_000 });
		await card.getByRole("button", { name: "Set as default runner" }).click();
		// Assert the persisted outcome (the toast is transient / unreliable to await).
		await expect
			.poll(() => runnerIsDefault(seeded.id), { timeout: 10_000 })
			.toBe(true);
	});

	test("removing a registered runner confirms via dialog and drops it from the grid", async ({
		team,
	}) => {
		const name = `e2e-remove-${Date.now()}`;
		const seeded = await seedRunner(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name },
		);
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = cardFor(team.page, name);
		await expect(card).toBeVisible({ timeout: 15_000 });

		await card.getByRole("button", { name: "Remove" }).click();
		// The registry's `runners.remove`: an alert-dialog naming the runner.
		await expect(team.page.getByRole("alertdialog")).toBeVisible();
		await expect(team.page.getByText(new RegExp(`Remove runner .*${name}`))).toBeVisible();
		// Confirmed on purpose, and ONLY here: this deletes a row THIS test seeded — the registry's
		// `prod-qa: own-rows-only` case. Every other destructive control in this domain is opened
		// and cancelled.
		await team.page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();

		await expect(card).toHaveCount(0, { timeout: 15_000 });
		await expect.poll(() => runnerExists(seeded.id), { timeout: 10_000 }).toBe(false);
	});

	test("the remove confirmation can be cancelled, leaving the runner in place", async ({ team }) => {
		const name = `e2e-cancel-${Date.now()}`;
		const seeded = await seedRunner(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name },
		);
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = cardFor(team.page, name);
		await expect(card).toBeVisible({ timeout: 15_000 });

		await card.getByRole("button", { name: "Remove" }).click();
		await team.page.getByRole("button", { name: "Cancel" }).click();
		await expect(team.page.getByRole("alertdialog")).toHaveCount(0);
		// The row is still there — a dialog that closes is not proof that nothing mutated.
		expect(await runnerExists(seeded.id)).toBe(true);
		await expect(card).toBeVisible();
	});
});

test.describe("Runners — the console filter standard", () => {
	test.afterEach(async ({ team }) => {
		await purgeE2ERunners(team.userId!);
	});

	test("search narrows the grid to the matching runner", async ({ team }) => {
		const stamp = Date.now();
		const alpha = `e2e-alpha-${stamp}`;
		const bravo = `e2e-bravo-${stamp}`;
		const id = { userId: team.userId!, orgId: team.orgId! };
		await seedRunner(id, { name: alpha });
		await seedRunner(id, { name: bravo });
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(cardFor(team.page, alpha)).toBeVisible({ timeout: 15_000 });

		await team.page.getByPlaceholder("Search runners by name…").fill("alpha");
		await expect(cardFor(team.page, alpha)).toBeVisible();
		await expect(cardFor(team.page, bravo)).toHaveCount(0);
	});

	test("a non-matching search shows the 'no runners match' message", async ({ team }) => {
		await seedRunner(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name: `e2e-filtermiss-${Date.now()}` },
		);
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await team.page.getByPlaceholder("Search runners by name…").fill("zzz-nonexistent-xyz");
		await expect(team.page.getByText("No runners match your filters.")).toBeVisible({
			timeout: 10_000,
		});
	});

	test("the bar carries all six axes the runner filter store declares", async ({ team }) => {
		// `use-runner-filters.ts` declares search + clouds + statuses + operators + regions +
		// versions. The previous spec looked for a "Filters" POPOVER holding status and operator —
		// a shape `runners-toolbar.tsx` has not had since the chip groups were promoted to
		// @repo/ui/filter-chip and inlined (`FilterChipGroup inline`). There is no Filters button
		// on this page, so that test could only ever have been red.
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(team.page.getByPlaceholder("Search runners by name…")).toBeVisible({
			timeout: 15_000,
		});
		await expect(team.page.getByPlaceholder("All clouds")).toBeVisible();
		// Status + operator are always-visible chips, not a popover.
		await expect(team.page.getByRole("button", { name: "Online", exact: true })).toBeVisible();
		await expect(team.page.getByRole("button", { name: "Draining", exact: true })).toBeVisible();
		await expect(
			team.page.getByRole("button", { name: "Self · Registered", exact: true }),
		).toBeVisible();
		// Region + version are facet popovers.
		await expect(team.page.getByRole("button", { name: "Region" })).toBeVisible();
		await expect(team.page.getByRole("button", { name: "Version" })).toBeVisible();
	});

	test("a chip selection mirrors into the URL and Reset clears both", async ({ team }) => {
		// The standard's client half (lib/query/README.md): the store is the source of truth and
		// `useFilterUrlSync` mirrors non-default values into the query string, so a filtered view
		// is shareable. Asserting the URL is what makes that half testable at all.
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const online = team.page.getByRole("button", { name: "Online", exact: true });
		await expect(online).toBeVisible({ timeout: 15_000 });

		await online.click();
		await expect(team.page).toHaveURL(/statuses=ONLINE/);
		await expect(online).toHaveAttribute("aria-pressed", "true");

		await team.page.getByRole("button", { name: /^Reset/ }).click();
		await expect(team.page).not.toHaveURL(/statuses=/);
		await expect(online).toHaveAttribute("aria-pressed", "false");
	});

	test("a pasted filter URL hydrates the bar and narrows the grid", async ({ team }) => {
		const stamp = Date.now();
		const id = { userId: team.userId!, orgId: team.orgId! };
		const live = `e2e-urlon-${stamp}`;
		const down = `e2e-urloff-${stamp}`;
		await seedRunner(id, { name: live, status: "ONLINE" });
		await seedRunner(id, { name: down, status: "OFFLINE" });

		await team.page.goto(`${RUNNERS_PATH(team.orgSlug)}?statuses=ONLINE`);
		// Non-vacuous by construction: the ONLINE runner must be PRESENT for the OFFLINE one's
		// absence to mean the filter ran rather than the list simply not having loaded.
		await expect(cardFor(team.page, live)).toBeVisible({ timeout: 15_000 });
		await expect(cardFor(team.page, down)).toHaveCount(0);
		await expect(
			team.page.getByRole("button", { name: "Online", exact: true }),
		).toHaveAttribute("aria-pressed", "true");
	});
});

test.describe("Runners — warm pools (self-managed only)", () => {
	let pool: SeededFleetPool;

	test.beforeAll(async () => {
		pool = await seedFleetPool();
	});

	test("a configured pool renders its card in the left column", async ({ team }) => {
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		await expect(team.page.getByText("Pools", { exact: true })).toBeVisible({ timeout: 15_000 });
		await expect(
			team.page.locator('[data-slot="card"]').filter({ hasText: pool.label }),
		).toBeVisible();
	});

	test("the pool delete confirmation opens, names the pool, and Cancel leaves it alone", async ({
		team,
	}) => {
		// The registry's `runners.pool.delete`: reach the "Pool actions" menu, the `Delete`
		// menuitem, the alert-dialog titled "Delete the <label> pool?". CANCEL ONLY — confirming
		// would set `deleting = true` on a GLOBAL platform row that no test owns and that the
		// fleet controller would then drain.
		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = team.page.locator('[data-slot="card"]').filter({ hasText: pool.label });
		await expect(card).toBeVisible({ timeout: 15_000 });

		await card.getByRole("button", { name: "Pool actions" }).click();
		await team.page.getByRole("menuitem", { name: "Delete" }).click();

		const dialog = team.page.getByRole("alertdialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText(`Delete the ${pool.label} pool?`)).toBeVisible();

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(team.page.getByRole("alertdialog")).toHaveCount(0);
		await expect(card).toBeVisible();
	});
});
