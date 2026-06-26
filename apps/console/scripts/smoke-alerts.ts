// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Live browser smoke of the alerts UI against a running dev server. Drives the REAL
// app in system Chrome: OTP sign-in, create a webhook channel (proves the encryption
// key is live), Test it (real verifyChannel → sender → endpoint), then DB-bind a policy,
// emit an event, and confirm the delivery shows in the Activity tab. Cleans up after.
// Run with env sourced (DB + ALETHIA_CRED_ENCRYPTION_KEY). Evidence: /tmp/smoke-*.png.

import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { chromium, type Page } from "@playwright/test";
import { eq } from "drizzle-orm";
import { emitAlertEvent } from "@/lib/alerts/emit";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { getServiceDb } from "@/lib/db";
import {
	alertChannels,
	alertDeliveries,
	alertRuleChannels,
	alertRules,
} from "@/lib/db/schema";

const BASE = "http://localhost:3100";
const EMAIL = "borislav@tovr.eu";
const DEV_LOG = "/tmp/alethia-dev.log";
const CATCHER_PORT = 3999;
const CHANNEL_NAME = "smoke-webhook";
const POLICY_NAME = "smoke-policy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (label: string, ok: boolean, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
	if (ok) passed++;
	else throw new Error(`FAILED: ${label}`);
};

/** Reads the newest 6-digit sign-in code logged after `fromOffset`. */
async function readOtp(fromOffset: number): Promise<string> {
	for (let i = 0; i < 40; i++) {
		const buf = readFileSync(DEV_LOG, "utf8").slice(fromOffset);
		const m = [...buf.matchAll(/sign-in code:\s*(\d{6})/g)];
		if (m.length) return m[m.length - 1][1];
		await sleep(500);
	}
	throw new Error("OTP code never appeared in the dev log");
}

async function shot(page: Page, name: string) {
	await page.screenshot({ path: `/tmp/smoke-${name}.png` });
}

async function main() {
	// ── local webhook catcher (the channel destination) ───────────────────────
	const hits: { headers: Record<string, string | string[] | undefined> }[] = [];
	const catcher = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			hits.push({ headers: req.headers });
			res.writeHead(200).end("ok");
		});
	});
	await new Promise<void>((r) => catcher.listen(CATCHER_PORT, r));

	const browser = await chromium.launch({ channel: "chrome", headless: true });
	const page = await browser.newPage();
	const db = getServiceDb();

	try {
		// ── 1. OTP sign-in ────────────────────────────────────────────────────
		await page.goto(`${BASE}/login`);
		await page.getByRole("button", { name: /Continue with Email/i }).click();
		await page.getByPlaceholder(/company.com/i).fill(EMAIL);
		const logOffset = statSync(DEV_LOG).size;
		await shot(page, "01-email");
		await page.getByRole("button", { name: /Continue/i }).click();

		const code = await readOtp(logOffset);
		check("OTP code scraped from dev log", /^\d{6}$/.test(code), code);
		const otp = page
			.locator('input[autocomplete="one-time-code"], [data-input-otp]')
			.first();
		await otp.click();
		await otp.pressSequentially(code, { delay: 60 });
		await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
		check("signed in → reached /dashboard", /\/dashboard/.test(page.url()), page.url());
		await shot(page, "02-dashboard");

		// ── 2. Alerts page renders ────────────────────────────────────────────
		await page.goto(`${BASE}/dashboard/alerts`);
		await page.getByRole("tab", { name: "Channels" }).click();
		await shot(page, "03-channels-tab");
		check(
			"alerts → Channels tab renders",
			await page.getByRole("button", { name: /New channel/i }).isVisible(),
		);

		// ── 3. Create a webhook channel (proves the key is live) ──────────────
		await page.getByRole("button", { name: /New channel/i }).click();
		await page.getByPlaceholder("#ops Slack").fill(CHANNEL_NAME);
		await page.getByPlaceholder("https://…").fill(`http://localhost:${CATCHER_PORT}/hook`);
		await shot(page, "04-channel-dialog");
		await page.getByRole("button", { name: /^Create$/ }).click();
		const channelRow = page.getByRole("row").filter({ hasText: CHANNEL_NAME });
		await channelRow.waitFor({ state: "visible", timeout: 10_000 });
		check("webhook channel saved (encryption key live)", true);
		await shot(page, "05-channel-created");

		// ── 4. Test button → real verifyChannel → sender → catcher ────────────
		const before = hits.length;
		await channelRow.getByRole("button", { name: "Test" }).click();
		for (let i = 0; i < 30 && hits.length === before; i++) await sleep(200);
		check("Test delivery reached the endpoint (live verifyChannel)", hits.length > before, `hits ${hits.length}`);
		await shot(page, "06-after-test");

		// ── 5. Bind a policy + emit → delivery shows in Activity ──────────────
		const [ch] = await db
			.select()
			.from(alertChannels)
			.where(eq(alertChannels.name, CHANNEL_NAME))
			.limit(1);
		check("channel persisted with org scope", Boolean(ch?.org_id), `org=${ch?.org_id?.slice(0, 8)}`);
		const [rule] = await db
			.insert(alertRules)
			.values({
				org_id: ch.org_id,
				name: POLICY_NAME,
				event_patterns: ["system.job.*"],
				severity: "critical",
				created_by: ch.created_by,
			})
			.returning();
		await db
			.insert(alertRuleChannels)
			.values({ rule_id: rule.id, channel_id: ch.id });
		invalidateOrgRules(ch.org_id);
		const n = await emitAlertEvent(ch.org_id, "system.job.failed", {
			title: "Smoke: job failed",
			severity: "critical",
		});
		check("emit(system.job.failed) created a delivery", n >= 1, `deliveries ${n}`);

		await page.goto(`${BASE}/dashboard/alerts`);
		await page.getByRole("tab", { name: "Activity" }).click();
		const deliveryRow = page.getByText("Smoke: job failed").first();
		const visible = await deliveryRow
			.waitFor({ state: "visible", timeout: 8_000 })
			.then(() => true)
			.catch(() => false);
		await shot(page, "07-activity");
		check("delivery is visible in the Activity tab", visible);

		// ── cleanup (remove smoke rows from the real org) ─────────────────────
		await db.delete(alertDeliveries).where(eq(alertDeliveries.channel_id, ch.id));
		await db.delete(alertRuleChannels).where(eq(alertRuleChannels.rule_id, rule.id));
		await db.delete(alertRules).where(eq(alertRules.id, rule.id));
		await db.delete(alertChannels).where(eq(alertChannels.id, ch.id));
		console.log("✓ cleaned up smoke channel/policy/deliveries");

		console.log(`\n${passed} checks passed`);
	} finally {
		await browser.close();
		catcher.close();
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error("\nSMOKE FAILED:", err instanceof Error ? err.message : err);
		process.exit(1);
	},
);
