// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Persona signup flows for the QA e2e suite. Each persona is a real account created once (serially,
// in global-setup) via the email-OTP flow; its Better Auth session is saved as a Playwright
// storageState so specs reuse it without racing the shared OTP log. See global-setup.ts.
//
// Personas:
//   ownerHobby — free-org owner (default surface for read/nav specs).
//   ownerTeam  — Pro (card-less trial) org owner; drives billing/seats/invite/RBAC breadth.
//   member     — invited into ownerTeam's org with the built-in `member` role.
//
// Selectors come from components/auth/auth-form.tsx and components/auth/onboarding-form.tsx.

import { type Page } from "@playwright/test";
import path from "node:path";
import { logCursor, waitForOtp } from "./otp";

/** Where per-persona storageState + resolved metadata live (gitignored). Anchored on the package cwd
 * (apps/console when Playwright runs) so it works under Playwright's CJS loader. */
export const AUTH_DIR = path.resolve(process.cwd(), "e2e/.auth");

export type PersonaName = "ownerHobby" | "ownerTeam" | "member";

/** Written by global-setup, read by fixtures: session file + the org each persona lands in. */
export interface PersonaRecord {
	name: PersonaName;
	email: string;
	orgSlug: string;
	orgId?: string;
	userId?: string;
	storageState: string;
}

export function storageStatePath(name: PersonaName): string {
	return path.join(AUTH_DIR, `${name}.json`);
}

export function personaMetaPath(): string {
	return path.join(AUTH_DIR, "personas.json");
}

/** A stable-ish unique email per persona per run (timestamped so reruns get fresh accounts). */
export function personaEmail(name: PersonaName, stamp: number): string {
	return `e2e-${name.toLowerCase()}-${stamp}@alethia.test`;
}

/**
 * Requests an email-OTP code for `email` on /signup (or /login) and submits it, landing the account
 * on whatever comes next (/onboarding for new accounts, the app for returning ones). Shared by every
 * persona flow; the caller captures the log cursor timing via waitForOtp internally.
 */
export async function emailOtpSignIn(page: Page, email: string, mode: "signup" | "login"): Promise<void> {
	const cursor = await logCursor();
	await page.goto(`/${mode}`);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	const code = await waitForOtp(cursor);
	await page.locator("input[data-input-otp]").first().fill(code);
}

/** Resolves the org slug from the current post-onboarding URL (/{slug}). */
function slugFromUrl(page: Page): string {
	return page.url().replace(/^https?:\/\/[^/]+\//, "").replace(/[/?#].*$/, "");
}

/** Public single-segment routes that are NOT an org slug — the landing wait must skip past them. */
const NON_ORG_SEGMENTS = new Set(["signup", "login", "onboarding", "invites", "start", "cli", "dashboard"]);

/** Waits until the URL is a real org overview (/{slug}), i.e. a single segment that isn't a known
 * public route. Onboarding's own `/onboarding` is a single segment, so it must be excluded. */
async function waitForOrgLanding(page: Page): Promise<string> {
	await page.waitForURL(
		(url) => {
			const parts = url.pathname.split("/").filter(Boolean);
			return parts.length === 1 && !NON_ORG_SEGMENTS.has(parts[0]);
		},
		{ timeout: 30_000 },
	);
	return slugFromUrl(page);
}

/**
 * Signs up a fresh account and completes onboarding on the Hobby (free) plan, landing on the org
 * overview at /{slug}. Returns the resolved org slug.
 */
export async function signUpHobby(page: Page, email: string): Promise<{ orgSlug: string }> {
	await emailOtpSignIn(page, email, "signup");
	await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
	await page.locator("#org-name").fill("E2E Hobby Org");
	// Hobby (community) tile is selected by default; click it for determinism, then create.
	await page.getByRole("button", { name: /personal projects/i }).click();
	await page.getByRole("button", { name: /create organization/i }).click();
	const orgSlug = await waitForOrgLanding(page);
	return { orgSlug };
}

/**
 * Signs up a fresh account and completes onboarding on the Pro plan via the card-less trial (a fresh
 * account still holds its one account-wide trial). Lands on the org overview. Returns the org slug.
 * Falls back to Hobby if the Pro tile is unavailable (Stripe unconfigured on this deployment).
 */
export async function signUpTeamTrial(page: Page, email: string): Promise<{ orgSlug: string; plan: "team" | "community" }> {
	await emailOtpSignIn(page, email, "signup");
	await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
	await page.locator("#org-name").fill("E2E Team Org");
	const proTile = page.getByRole("button", { name: /commercial projects/i });
	const proDisabled = await proTile.isDisabled().catch(() => true);
	if (proDisabled) {
		// Stripe not configured — record intent to fall back so the suite still runs.
		await page.getByRole("button", { name: /personal projects/i }).click();
		await page.getByRole("button", { name: /create organization/i }).click();
		const orgSlug = await waitForOrgLanding(page);
		return { orgSlug, plan: "community" };
	}
	await proTile.click();
	// Trial path shows "Create organization" (card-less); paid path shows "Continue to payment".
	// A fresh account should always get the trial; guard for the paid label just in case.
	const createBtn = page.getByRole("button", { name: /create organization/i });
	const payBtn = page.getByRole("button", { name: /continue to payment/i });
	if (await payBtn.isVisible().catch(() => false)) {
		// No trial available (shouldn't happen for a fresh account) — bail to community.
		await page.getByRole("button", { name: /personal projects/i }).click();
		await createBtn.click();
	} else {
		await createBtn.click();
	}
	const orgSlug = await waitForOrgLanding(page);
	return { orgSlug, plan: "team" };
}
