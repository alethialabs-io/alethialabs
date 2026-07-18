// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Standalone marketing-stills capture: signs in as the SEEDED demo owner via the
// real email-OTP flow (OTP scraped from the console stdout log), then captures
// crisp, high-DPI, dark-theme stills of the real console for the hero video +
// section imagery. Standalone (not the Playwright test runner) for control +
// debuggability. Run against a `pnpm dev:up` console with the demo org seeded:
//   pnpm -F console exec node scripts/capture-stills.mjs
// Env: CAPTURE_EMAIL, CAPTURE_ORG, CAPTURE_PROJECT, E2E_BASE_URL, HEADED=1.

import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../../../demos/proofs/marketing-capture/stills");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.CAPTURE_EMAIL ?? "dana@acme.example";
const ORG = process.env.CAPTURE_ORG ?? "demo-acme";
const PROJECT = process.env.CAPTURE_PROJECT ?? "payments-api";
mkdirSync(OUT, { recursive: true });

// Read the email-OTP straight from Better Auth's `verification` table (stored
// plaintext as `<code>:<attempts>`) — a deterministic seam that avoids any
// dependency on email delivery or log scraping.
const PG = process.env.CAPTURE_PG_CONTAINER ?? "alethia-postgres-1";
// Better Auth reuses a still-valid OTP within its window (no new row), so we read
// the latest NON-EXPIRED code for the email — that's the one it will accept.
function validOtp(email) {
	const sql = `select value from verification where identifier = 'sign-in-otp-${email}' and expires_at > now() order by expires_at desc limit 1;`;
	const out = execFileSync("docker", ["exec", PG, "psql", "-U", "alethia", "-d", "alethia", "-t", "-A", "-c", sql]).toString().trim();
	return out ? out.split(":")[0] : null;
}
async function waitForDbOtp(email, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const code = validOtp(email);
		if (code) return code;
		await new Promise((r) => setTimeout(r, 400));
	}
	throw new Error(`no valid OTP for ${email} within ${timeoutMs}ms`);
}

const main = async () => {
	const browser = await chromium.launch({ channel: "chrome", headless: process.env.HEADED !== "1" });
	const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, colorScheme: "dark" });
	const page = await ctx.newPage();
	page.setDefaultTimeout(20_000);

	// --- sign in as the seeded owner via email-OTP (code read from the DB) ---
	await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(900);
	await page.screenshot({ path: "/tmp/login-debug.png" });
	console.log("[login] buttons:", (await page.locator("button").allInnerTexts()).map((t) => t.trim()).filter(Boolean).slice(0, 8));

	const emailInput = page.locator("#email");
	if (!(await emailInput.isVisible().catch(() => false))) {
		await page.getByRole("button", { name: /continue with email/i }).click({ force: true });
		await page.waitForTimeout(400);
	}
	await emailInput.waitFor({ state: "visible" });
	await emailInput.fill(EMAIL);
	// In the email step the only "Continue with email" button is the submit; clicking
	// auto-waits for React to enable it (disabled while the email field is empty).
	await page.getByRole("button", { name: /continue with email/i }).click({ timeout: 10_000 });
	console.log(`[login] requested OTP for ${EMAIL}`);

	const code = await waitForDbOtp(EMAIL);
	console.log(`[login] got code ${code}`);
	await page.waitForTimeout(1200);
	await page.screenshot({ path: "/tmp/otp-debug.png" });
	// input-otp uses a visually-hidden input; focus + type (onComplete auto-verifies).
	const otp = page.locator("input[data-input-otp]").first();
	await otp.waitFor({ state: "attached", timeout: 15_000 });
	await otp.focus();
	await page.keyboard.type(code, { delay: 45 });
	await page.waitForURL((u) => /^\/[^/]+$/.test(new URL(u).pathname) && !/\/(login|signup|onboarding)$/.test(new URL(u).pathname), { timeout: 30_000 });
	await page.evaluate(() => localStorage.setItem("theme", "dark"));
	console.log(`[login] signed in → ${page.url()}`);

	// --- shots ---
	const shot = async (name, settle = 900) => {
		await page.waitForTimeout(settle);
		await page.screenshot({ path: `${OUT}/${name}.png` });
		console.log(`[shot] ${name}`);
	};
	const step = async (label, fn) => {
		try {
			await fn();
		} catch (e) {
			console.log(`[shot] skipped ${label}: ${(e?.message ?? e).toString().split("\n")[0]}`);
		}
	};

	await step("overview", async () => {
		await page.goto(`${BASE}/${ORG}`, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(400);
		await shot("01-overview", 1500);
	});
	await step("connectors", async () => {
		await page.goto(`${BASE}/${ORG}/~/connectors`, { waitUntil: "domcontentloaded" });
		await shot("02-connectors", 1200);
	});
	await step("canvas", async () => {
		await page.goto(`${BASE}/${ORG}/${PROJECT}/architecture`, { waitUntil: "domcontentloaded" });
		await page.getByText(/cluster/i).first().waitFor({ timeout: 25_000 });
		await shot("03-canvas", 2200);
	});
	await step("inspector", async () => {
		await page.getByText(/^Cluster$/).first().click({ timeout: 8_000 });
		await shot("04-inspector", 1400);
	});
	await step("evidence", async () => {
		await page.goto(`${BASE}/${ORG}/~/evidence`, { waitUntil: "domcontentloaded" });
		// Wait for the posture rows to load (route may compile on first hit); fall back
		// to whatever renders after a generous settle.
		await page.getByText(/passed|blocked|warnings|not evaluable|production|staging/i).first().waitFor({ timeout: 20_000 }).catch(() => {});
		await shot("05-evidence", 2500);
	});
	await step("evidence-drawer", async () => {
		const row = page.getByRole("row").filter({ hasText: /production|staging|development/i }).first();
		await row.click({ timeout: 10_000 });
		await shot("06-evidence-report", 1300);
	});
	await step("evidence-receipt", async () => {
		await page.getByRole("tab", { name: /receipt/i }).click({ timeout: 6_000 });
		await shot("07-receipt", 1200);
	});
	await step("jobs", async () => {
		await page.goto(`${BASE}/${ORG}/~/jobs`, { waitUntil: "domcontentloaded" });
		await shot("08-jobs", 1300);
	});
	await step("job-detail", async () => {
		await page.locator("tbody tr, [role='row'], a[href*='/~/jobs/']").filter({ hasText: /apply|deploy|plan|success/i }).first().click({ timeout: 8_000 });
		await page.waitForURL(/\/~\/jobs\/[^/]+$/, { timeout: 12_000 });
		await shot("09-job-logs", 1600);
	});
	await step("runners", async () => {
		await page.goto(`${BASE}/${ORG}/~/runners`, { waitUntil: "domcontentloaded" });
		await shot("10-runners", 1500);
	});
	await step("elench", async () => {
		await page.goto(`${BASE}/${ORG}`, { waitUntil: "domcontentloaded" });
		await page.waitForTimeout(800);
		const btn = page.getByRole("button", { name: /ask ai|elench|assistant/i }).first();
		if (await btn.isVisible().catch(() => false)) await btn.click();
		else await page.keyboard.press("Meta+i");
		await shot("11-elench", 1600);
	});

	console.log(`\n[capture] done → ${OUT}`);
	await browser.close();
};

main().catch((e) => {
	console.error("capture failed:", e);
	process.exit(1);
});
