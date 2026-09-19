// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runners domain — gate / tenancy / destructive-confirmation paths.
//
// THE ENTITLEMENT GATE IS NOT MEASURABLE ON THIS LEG, and pretending otherwise is what the two
// tests this file used to open with did. `runners-client.tsx` renders `<FeatureUpsell feature="byoRunners" />`
// only when `isHosted && !canByoRunners`; `isHosted` comes from `deploymentMode()`, which answers
// "hosted" only for a literal `ALETHIA_DEPLOYMENT_MODE=hosted`. `.github/workflows/release-gate.yml`
// sets that variable NOWHERE and says why it must not ("packages/email then refuses the OTP log
// fallback and nothing can sign in") — so the console every leg drives is SELF-MANAGED, the gate is
// inert, and a Hobby org sees the runner surface. The old spec asserted the upsell copy and had been
// red in gate-baseline.json ever since it was captured.
//
// So the first test below asserts what the deployment ACTUALLY does, and says so in its name. The
// upsell branch needs a `hosted` capability promise on some leg before it can be a test rather than
// a wish; that lives in the workflow + helpers/capabilities.ts, which this lane does not own.

import { test, expect } from "../fixtures/qa";
import {
	destroyJobCount,
	purgeSeededRunners,
	purgeSeededIdentity,
	seedDeployedRunner,
	seedRunner,
} from "../helpers/seed-runners";

// Cold-compiled bundle on first hit — give navigation-heavy flows headroom over the 30s default.
test.describe.configure({ timeout: 90_000 });

const RUNNERS_PATH = (slug: string) => `/${slug}/~/runners`;

/** A runner card, located by the name printed in its header. */
const cardFor = (page: import("@playwright/test").Page, name: string) =>
	page.locator('[data-slot="card"]').filter({ hasText: name });

/**
 * The open destroy popover.
 *
 * Scoped to `[data-slot="popover-content"]` (packages/ui/popover.tsx puts it on the base-ui Popup)
 * rather than reached as `getByRole("button", { name: "Destroy" }).last()`. The confirm shares its
 * label with every card's trigger, and `.last()` only meant "the portal, appended after the grid"
 * while exactly ONE deployed runner existed in the org. Two specs in this file now seed one each and
 * the suite is fullyParallel, so `.last()` had become a bet on DOM order between two cards.
 */
const destroyPopover = (page: import("@playwright/test").Page) =>
	page.locator('[data-slot="popover-content"]');

test.describe("Runners — the byoRunners gate is deployment-mode scoped", () => {
	test("a Hobby org reaches the runner surface, because the upsell is hosted-only", async ({
		owner,
	}) => {
		await owner.page.goto(RUNNERS_PATH(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		// The surface, not the panel: `FeatureUpsell` would replace the whole page with its title.
		await expect(owner.page.getByRole("button", { name: "Add runner" }).first()).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page.getByText("Bring your own runners")).toHaveCount(0);
	});

	test("a runner in another org never appears in this org's grid", async ({ owner, team }) => {
		// The tenancy assertion the entitlement tests were standing in for. Both halves are
		// asserted — a denial only counts where somebody else DOES see the row, otherwise an empty
		// grid passes this vacuously (flows/_persona-integrity.spec.ts).
		//
		// SEEDED INTO THE *TEAM* ORG, NEVER THE HOBBY ONE, and the direction is load-bearing. The
		// sidebar's Runners entry is gated on `orgHasSelfRunners(orgId)` ([org]/layout.tsx), so a
		// self runner in an org makes that nav link APPEAR. Three navigation-shell tests are
		// recorded `failed` in gate-baseline.json precisely because the Hobby org has none; seeding
		// one there — even inside a try/finally — opens a window in which those three can pass, and
		// the ratchet is shrink-only, so it would fail the whole leg naming a file this lane does
		// not own and cannot re-baseline. Every other runners spec already seeds into the team org,
		// so this direction adds no window that was not already open.
		const name = `e2e-tenancy-${Date.now()}`;
		await seedRunner({ userId: team.userId!, orgId: team.orgId! }, { name });
		try {
			await team.page.goto(RUNNERS_PATH(team.orgSlug));
			await expect(cardFor(team.page, name)).toBeVisible({ timeout: 15_000 });

			await owner.page.goto(RUNNERS_PATH(owner.orgSlug));
			await expect(owner.page.getByRole("button", { name: "Add runner" }).first()).toBeVisible({
				timeout: 15_000,
			});
			await expect(cardFor(owner.page, name)).toHaveCount(0);
		} finally {
			await purgeSeededRunners();
		}
	});
});

test.describe("Runners — destroy", () => {
	let identityId: string | null = null;

	test.afterEach(async () => {
		if (identityId) await purgeSeededIdentity(identityId);
		identityId = null;
		await purgeSeededRunners();
	});

	test("the destroy confirmation opens, warns, and dismissing it queues nothing", async ({
		team,
	}) => {
		// The registry's `runners.destroy` — `confirm: popover`, `confirm_action: "Destroy"`. A
		// popover has no Cancel button, so the dismissal is Escape; the assertion that matters is
		// the one after it, that no job was enqueued. A dialog that merely closed is not evidence.
		const name = `e2e-destroy-cancel-${Date.now()}`;
		const { runner, identityId: id } = await seedDeployedRunner(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name },
		);
		identityId = id;

		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = cardFor(team.page, name);
		await expect(card).toBeVisible({ timeout: 15_000 });

		await card.getByRole("button", { name: "Destroy" }).click();
		const popover = destroyPopover(team.page);
		await expect(popover.getByText("Select runner")).toBeVisible();
		await expect(
			popover.getByText(new RegExp(`This will tear down all cloud resources for "${name}"`)),
		).toBeVisible();

		await team.page.keyboard.press("Escape");
		await expect(popover).toHaveCount(0);
		expect(await destroyJobCount(runner.id)).toBe(0);
	});

	test("destroying a deployed runner queues a DESTROY_RUNNER job", async ({ team }) => {
		// The unit this issue is named for. Destroy renders only for a self-operated runner that is
		// `provisioning: "deployed"` AND carries both a cloud identity and a `deploy_config`
		// (`RunnerActions.hasCloudResources`) — a state no UI flow in this suite can reach, because
		// producing it means running a real DEPLOY_RUNNER job against a real cloud account. So it
		// is seeded, by the ONE helper that knows the full conjunction. Stops at "job QUEUED": no
		// tofu runs here (AUTHORING.md → "What NOT to test end-to-end").
		const name = `e2e-destroy-${Date.now()}`;
		const { runner, identityId: id } = await seedDeployedRunner(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name },
		);
		identityId = id;

		await team.page.goto(RUNNERS_PATH(team.orgSlug));
		const card = cardFor(team.page, name);
		await expect(card).toBeVisible({ timeout: 15_000 });

		// Open the destroy popover from the card, then confirm. The confirm control shares the
		// "Destroy" label with its trigger, so it is reached inside the popover, never positionally.
		await card.getByRole("button", { name: "Destroy" }).click();
		const popover = destroyPopover(team.page);
		await expect(popover.getByText("Select runner")).toBeVisible();
		await popover.getByRole("button", { name: "Destroy" }).click();

		// The job is inserted QUEUED. Assert only that it EXISTS — a live runner sharing this
		// database could claim and then fail it against the fake credentials, and pinning a
		// transient status would make this test a race.
		await expect
			.poll(() => destroyJobCount(runner.id), { timeout: 15_000 })
			.toBeGreaterThanOrEqual(1);
	});
});
