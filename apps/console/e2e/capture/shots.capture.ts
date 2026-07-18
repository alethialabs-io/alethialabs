// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Captures crisp, high-DPI, dark-theme stills of the REAL console against the
// seeded demo org — the source frames for the marketing hero video (ffmpeg Ken
// Burns) and the section imagery. Each shot is best-effort: a fragile selector
// logs and continues rather than sinking the whole capture.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const ORG = process.env.CAPTURE_ORG ?? "demo-acme";
const PROJECT = process.env.CAPTURE_PROJECT ?? "payments-api";
const OUT = path.resolve(__dirname, "../../../../demos/proofs/marketing-capture/stills");

test("capture marketing stills", async ({ page }) => {
	mkdirSync(OUT, { recursive: true });
	test.setTimeout(180_000);

	const shot = async (name: string, settle = 700) => {
		await page.waitForTimeout(settle);
		await page.screenshot({ path: path.join(OUT, `${name}.png`) });
		console.log(`[shot] ${name}`);
	};
	/** Runs an interaction, swallowing + logging any failure so capture continues. */
	const tryStep = async (label: string, fn: () => Promise<void>) => {
		try {
			await fn();
		} catch (e) {
			console.log(`[shot] skipped ${label}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
		}
	};

	// 01 — Overview (projects, day-2 posture)
	await page.goto(`/${ORG}`);
	await expect(page.getByText(/overview|projects/i).first()).toBeVisible({ timeout: 30_000 });
	await shot("01-overview", 1200);

	// 02 — Connectors (keyless federated)
	await tryStep("connectors", async () => {
		await page.goto(`/${ORG}/~/connectors`);
		await expect(page.getByText(/connect|cloud/i).first()).toBeVisible({ timeout: 20_000 });
		await shot("02-connectors", 1000);
	});

	// 03 — The canvas IS the design surface
	await tryStep("canvas", async () => {
		await page.goto(`/${ORG}/${PROJECT}/architecture`);
		await expect(page.getByText(/cluster/i).first()).toBeVisible({ timeout: 30_000 });
		await shot("03-canvas", 1800);
	});

	// 04 — Node inspector (config lives here, not a form)
	await tryStep("inspector", async () => {
		await page.getByText(/^Cluster$/i).first().click({ timeout: 8_000 });
		await shot("04-inspector", 1200);
	});

	// 05/06/07 — Evidence: table → drawer → receipt (the proof)
	await tryStep("evidence", async () => {
		await page.goto(`/${ORG}/~/evidence`);
		await expect(page.getByText(/evidence|environments/i).first()).toBeVisible({ timeout: 20_000 });
		await shot("05-evidence", 1000);
	});
	await tryStep("evidence-drawer", async () => {
		// Open the first environment row's drawer.
		await page.locator("tbody tr, [role='row']").filter({ hasText: /production|prod|payments|storefront/i }).first().click({ timeout: 8_000 });
		await shot("06-evidence-report", 900);
	});
	await tryStep("evidence-receipt", async () => {
		await page.getByRole("tab", { name: /receipt/i }).click({ timeout: 6_000 });
		await shot("07-receipt", 900);
	});

	// 08/09 — Jobs list + streamed log viewer (day-2 ops)
	await tryStep("jobs", async () => {
		await page.goto(`/${ORG}/~/jobs`);
		await expect(page.getByRole("heading", { name: /jobs/i }).first()).toBeVisible({ timeout: 20_000 });
		await shot("08-jobs", 1000);
	});
	await tryStep("job-detail", async () => {
		await page.locator("tbody tr, [role='row'], a[href*='/~/jobs/']").filter({ hasText: /apply|deploy|plan|success/i }).first().click({ timeout: 8_000 });
		await page.waitForURL(/\/~\/jobs\/[^/]+$/, { timeout: 12_000 });
		await shot("09-job-logs", 1400);
	});

	// 10 — Runners / fleet
	await tryStep("runners", async () => {
		await page.goto(`/${ORG}/~/runners`);
		await expect(page.getByText(/runner|pool/i).first()).toBeVisible({ timeout: 20_000 });
		await shot("10-runners", 1200);
	});

	// 11 — Elench (the agent surface)
	await tryStep("elench", async () => {
		await page.goto(`/${ORG}`);
		await page.waitForTimeout(800);
		const askAi = page.getByRole("button", { name: /ask ai|elench|assistant/i }).first();
		if (await askAi.isVisible().catch(() => false)) await askAi.click();
		else await page.keyboard.press("Meta+i");
		await shot("11-elench", 1400);
	});

	console.log(`[capture] stills written to ${OUT}`);
});
