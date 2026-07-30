// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE HERO HAPPY-PATH — the sellable browser flow a human demos, end to end, hermetically:
//
//   sign in (email-OTP) → onboarding → create org → see the "connect a cloud" surface →
//   create a project → design on the canvas → reach the Deploy / pending-changes state →
//   land on the evidence + clusters surfaces.
//
// Everything here is deterministic and needs NO real cloud creds, no external email, no OAuth:
//   • Auth is the real email-OTP flow with the code scraped from the console log (fixtures/auth).
//   • The project is created via the "Create empty project" path (name only — no cloud identity),
//     so we reach the design canvas without connecting a real account.
//
// THE HONEST BOUNDARY (read before extending): we assert we reach the Deploy / pending-changes
// state and that the Deploy CTA is present — we do NOT click Deploy. Clicking it queues real
// provisioning (applyStagedChanges → provisionProject), which requires a *verified* cloud identity
// and would then stand up real infrastructure. A truthful browser test stops here; it does not fake
// a QUEUED job or a live cluster. To extend to an actual "DEPLOY job is QUEUED" assertion, seed a
// verified cloud_identity for the org (a mocked/seeded connector) and select it in create-project —
// see e2e/README.md. The clusters surface below correctly shows its empty state ("appears after you
// deploy"), which is exactly the truth for this hermetic run.

import { expect, test } from "@playwright/test";
import { signUpWithOtp } from "./fixtures/auth";

test.describe("Hero happy-path", () => {
	// The full path crosses many routes (auth → onboarding → org → create → canvas → evidence);
	// give it room over the per-assertion defaults, especially on a cold CI server.
	test.slow();

	test("sign in → org → connect-a-cloud → design → deploy state → evidence/clusters", async ({
		page,
	}) => {
		// 1. Onboarding / sign-in → a brand-new org (the live demo of the auth+onboarding surface).
		const { orgSlug } = await signUpWithOtp(page);
		expect(page.url()).toContain(`/${orgSlug}`);

		// 2. Org overview — the first-run "Get started" setup guide is the sellable onboarding surface.
		//    Opening it proves the org exists and surfaces the "Connect a cloud" step.
		await page.getByRole("button", { name: /setup guide/i }).click();
		// .first(): the "connect a cloud" copy appears in several components; the visible one here is
		// the setup-guide step title. Pin to the first match to stay strict-mode-safe if others mount.
		await expect(page.getByText(/connect a cloud/i).first()).toBeVisible();
		await page.keyboard.press("Escape");

		// 3. The connect-a-cloud surface. We assert the connector browser renders and a real cloud
		//    (AWS) is offered — the entry point to connecting an account. Actually verifying a cloud
		//    needs real creds, so the hero path asserts the surface, not a live connection.
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(page.getByPlaceholder(/search connectors/i)).toBeVisible();
		await page.getByPlaceholder(/search connectors/i).fill("AWS");
		await expect(page.getByText("AWS").first()).toBeVisible();

		// 4. Design a project. The two-step create flow: on `~/new` pick a source, then Configure it.
		//    The "Blank project" card needs no cloud identity (an empty project, cloud chosen later on
		//    the canvas) — which keeps this step hermetic and lands us on the design canvas.
		await page.goto(`/${orgSlug}/~/new`);
		await expect(
			page.getByRole("heading", { name: /provision the future/i }),
		).toBeVisible();
		// Step 1 → step 2: the Blank scratch card routes to the Configure screen.
		await page.getByRole("button", { name: /blank project/i }).click();
		await expect(
			page.getByRole("heading", { name: /configure your project/i }),
		).toBeVisible();
		await page.locator("#project_name").fill("hero-e2e");
		await page.getByRole("button", { name: /create project/i }).click();

		// 5. The project canvas is ready once its chrome (the "Add" control) is painted. (This used to
		//    anchor on the "Project settings" cog, which was removed — the project root is edited via
		//    its board card now — so it anchors on the Add button, which the next step drives anyway.)
		const addButton = page.getByRole("button", { name: "Add", exact: true });
		await expect(addButton).toBeVisible({ timeout: 45_000 });

		// 6. Design something — open the Add palette and drop a Bucket (object storage) onto the
		//    canvas. Bucket has no variant step, so selecting it adds the node and closes the palette.
		await addButton.click();
		const search = page.getByPlaceholder(/search services/i);
		await expect(search).toBeVisible();
		await search.fill("bucket");
		await page.getByRole("option", { name: /bucket/i }).first().click();

		// 7. The Deploy / pending-changes state — the canvas diff surfaces the staged change with a
		//    Deploy CTA. THIS IS THE HONEST BOUNDARY: we assert Deploy is offered but never click it
		//    (clicking would queue real provisioning against a cloud we haven't verified).
		await expect(page.getByText("Pending changes").first()).toBeVisible();
		await expect(page.getByRole("button", { name: /^deploy$/i })).toBeVisible();

		// 8. Land on the evidence surface — the org's "keep proving it" roll-up. Creating a
		//    project ALWAYS seeds its environment matrix (lib/queries/projects.ts — four rows
		//    via DEFAULT_ENVIRONMENT_MATRIX, or two on the legacy path), so by now the org has
		//    environments and the page renders the posture table. They are DRAFT and unverified,
		//    which is the honest state for a run that stops before a deploy.
		//
		//    This used to assert the "No environments yet" onboarding state, and passed — because
		//    CI ran a COMMUNITY console (ee/dist was never built), where getOrgEvidence
		//    short-circuits to EMPTY_EVIDENCE for the personal scope. The page was empty
		//    regardless of data, so the assertion could not fail. CI now builds ee, so this
		//    exercises the EE scope that production and the sandbox box run.
		await page.goto(`/${orgSlug}/~/evidence`);
		await expect(
			page.getByRole("heading", { name: /environments/i }).first(),
		).toBeVisible();
		await expect(page.getByText("production").first()).toBeVisible();
		await expect(page.getByText("No environments yet")).toHaveCount(0);

		// 9. …and the clusters surface. Nothing is provisioned (we stopped before a real deploy), so it
		//    correctly renders the empty state — the truthful end of a hermetic hero run. (List pages no
		//    longer render a page-title heading since #762's "no list-page headers" pass, so assert the
		//    empty state itself, not a "Clusters" heading.)
		await page.goto(`/${orgSlug}/~/clusters`);
		await expect(page.getByText(/no clusters provisioned/i)).toBeVisible();
	});
});
