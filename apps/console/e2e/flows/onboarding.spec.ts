// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Onboarding domain — happy paths + structure, end to end:
//   signup → email-OTP (and its resend cooldown) → /onboarding plan pick (Hobby vs Pro trial)
//   → the clickwrap gate → org overview; returning-user /login; the org switcher, a second
//   organization and switching between them; the invitation accept round-trip; the CLI
//   hand-off; signing out; and public-route auth gating.
//
// This domain performs REAL fresh signups (unique timestamped accounts) via the email-OTP
// log seam (helpers/otp.ts). Negatives (validation / wrong-code / reserved slug / a refused
// invitation / a malformed CLI link) live in onboarding.negative.spec.ts. Selectors come from
// components/auth/{auth-form,onboarding-form}, components/legal/accept-terms-form,
// components/org-switcher and components/org/create-org-sheet.
//
// TWO THINGS THIS FILE MUST NEVER DO, both learned from what they would break:
//   · never sign a PERSONA out. Every persona context in a run is restored from one
//     storageState holding one Better Auth session token, so `signOut` revokes it for the
//     whole suite. The sign-out test creates a throwaway account instead.
//   · never create a second organization for `owner`. That spends the account-wide trial the
//     create-org-sheet test in this same file asserts is still available. The `member`
//     persona already belongs to two orgs, so the switching tests read it rather than making
//     one.

import fs from "node:fs";
import { test, expect } from "../fixtures/qa";
import { ACCEPTANCE_LABELS } from "@repo/legal/documents";
import { scanA11y } from "../helpers/a11y";
import { pendingInvitationId } from "../helpers/db";
import { logCursor, waitForOtp } from "../helpers/otp";
import { organizationApi, signUpHobby } from "../helpers/personas";
import type { Page } from "@playwright/test";

/** A unique, never-before-registered test email so each signup creates a fresh account. */
function freshEmail(tag: string): string {
	return `e2e-onb-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@alethia.test`;
}

/** Reads the ownerHobby persona's email from the metadata global-setup wrote. */
function ownerHobbyEmail(): string {
	const meta = JSON.parse(fs.readFileSync("e2e/.auth/personas.json", "utf8"));
	return meta.ownerHobby.email as string;
}

/**
 * Local email-OTP sign-in, mirroring helpers/personas.emailOtpSignIn but with a longer OTP
 * wait — under a busy dev server the code can land in the log later than the shared 20s default.
 */
export async function otpSignIn(page: Page, email: string, mode: "signup" | "login"): Promise<void> {
	const cursor = await logCursor();
	await page.goto(`/${mode}`);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	const code = await waitForOtp(cursor, { timeoutMs: 150_000 });
	await page.locator("input[data-input-otp]").first().fill(code);
}

/** Runs a fresh signup through email-OTP and waits until the /onboarding wizard renders. */
async function freshSignupToOnboarding(page: Page, email: string): Promise<void> {
	// The OTP can land in the log late under a busy dev server (helper waits up to 60s) —
	// give the whole test headroom beyond the 30s default so a slow code doesn't time it out.
	test.setTimeout(180_000);
	await otpSignIn(page, email, "signup");
	await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
	await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible({
		timeout: 15_000,
	});
}

/** True once the URL is a real org overview (a single non-public path segment). */
function isOrgOverview(url: URL): boolean {
	const parts = url.pathname.split("/").filter(Boolean);
	const publicSeg = new Set(["signup", "login", "onboarding", "invites", "dashboard", "start", "cli"]);
	return parts.length === 1 && !publicSeg.has(parts[0]);
}

// ── Public auth pages ────────────────────────────────────────────────────────────

test.describe("Onboarding — public auth pages", () => {
	test("signup page renders the create-account hero", async ({ page }) => {
		await page.goto("/signup");
		await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /continue with email/i })).toBeVisible();
	});

	test("login page renders the returning-user hero", async ({ page }) => {
		await page.goto("/login");
		await expect(page.getByRole("heading", { name: /log in to alethia/i })).toBeVisible();
	});

	test("signup offers OAuth providers (GitHub, Google)", async ({ page }) => {
		await page.goto("/signup");
		await expect(page.getByRole("button", { name: /github/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /google/i })).toBeVisible();
	});

	test("SSO option is present but disabled (coming soon)", async ({ page }) => {
		await page.goto("/login");
		const sso = page.getByRole("button", { name: /continue with sso/i });
		await expect(sso).toBeVisible();
		await expect(sso).toBeDisabled();
	});

	test("signup email step reveals the work-email field", async ({ page }) => {
		await page.goto("/signup");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await expect(page.getByRole("heading", { name: /sign up with email/i })).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
	});

	test("login email step reveals the sign-in email field", async ({ page }) => {
		await page.goto("/login");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await expect(page.getByRole("heading", { name: /sign in with email/i })).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
	});

	test("email step can navigate back to the provider list", async ({ page }) => {
		await page.goto("/signup");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await page.getByRole("button", { name: /other sign-in options/i }).click();
		await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
	});

	test("signup ?email= prefills the email and skips the provider grid", async ({ page }) => {
		const pref = "prefilled@company.com";
		await page.goto(`/signup?email=${encodeURIComponent(pref)}`);
		await expect(page.locator("#email")).toHaveValue(pref);
	});

	test("signup page has no serious a11y violations", async ({ page }) => {
		await page.goto("/signup");
		await expect(page.getByRole("heading", { name: /create your account/i })).toBeVisible();
		const violations = await scanA11y(page);
		expect(violations, JSON.stringify(violations)).toEqual([]);
	});
});

// ── Fresh signup + plan pick ──────────────────────────────────────────────────────

test.describe("Onboarding — fresh signup + plan pick", () => {
	test("onboarding wizard shows both self-serve plan tiles", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("tiles"));
		await expect(page.getByRole("button", { name: /personal projects/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /commercial projects/i })).toBeVisible();
		// The Hobby tile is selected by default.
		await expect(page.getByRole("button", { name: /personal projects/i })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
	});

	test("onboarding lets you customize the org URL slug", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("url"));
		await page.getByRole("button", { name: /customize url/i }).click();
		// Toggling reveals the inline slug editor; the toggle now reads "Done".
		await expect(page.getByRole("button", { name: /^done$/i })).toBeVisible();
	});

	test("full Hobby signup lands on the org overview", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("hobby"));
		const orgName = `E2E Hobby ${Date.now()}`;
		await page.locator("#org-name").fill(orgName);
		await page.getByRole("button", { name: /personal projects/i }).click();
		await page.getByRole("button", { name: /create organization/i }).click();
		await page.waitForURL((url) => isOrgOverview(url), { timeout: 30_000 });
		await expect(page).not.toHaveURL(/\/onboarding/);
		await expect(page.getByRole("link", { name: /create.*project/i }).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("full Pro-trial signup lands on the org overview", async ({ page }) => {
		await freshSignupToOnboarding(page, freshEmail("pro"));
		// Stacks signup-OTP latency + a Stripe trial-subscription create — extra headroom.
		test.setTimeout(300_000);
		const proTile = page.getByRole("button", { name: /commercial projects/i });
		test.skip(await proTile.isDisabled(), "Stripe not configured — Pro tile disabled");
		await page.locator("#org-name").fill(`E2E Pro ${Date.now()}`);
		await proTile.click();
		// A fresh account still holds its one trial → card-less "Create organization".
		await expect(page.getByText(/trial · no card required/i)).toBeVisible();
		await page.getByRole("button", { name: /create organization/i }).click();
		await page.waitForURL((url) => isOrgOverview(url), { timeout: 60_000 });
		await expect(page).not.toHaveURL(/\/onboarding/);
	});
});

// ── Returning-user login ──────────────────────────────────────────────────────────

test.describe("Onboarding — returning user login", () => {
	test("an already-onboarded account logs in and skips onboarding", async ({ page }) => {
		test.setTimeout(180_000);
		await otpSignIn(page, ownerHobbyEmail(), "login");
		// Returning user goes to /dashboard → active org, never back into /onboarding.
		await page.waitForURL((url) => isOrgOverview(url), { timeout: 30_000 });
		await expect(page).not.toHaveURL(/\/onboarding/);
		await expect(page).not.toHaveURL(/\/login/);
	});
});

// ── Org switcher + create-org sheet ─────────────────────────────────────────────────

test.describe("Onboarding — org switcher + create-org sheet", () => {
	test("switcher shows the active org and its plan badge", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await expect(owner.page.getByPlaceholder(/find organization/i)).toBeVisible();
		await expect(owner.page.getByRole("option", { name: /e2e hobby org/i }).first()).toBeVisible();
	});

	test("switcher exposes the create-organization action", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await expect(owner.page.getByRole("button", { name: /create organization/i })).toBeVisible();
	});

	test("create-organization opens the purchase sheet", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await expect(
			owner.page.getByRole("heading", { level: 1, name: /create a team/i }),
		).toBeVisible();
		await expect(owner.page.getByPlaceholder(/acme cloud/i)).toBeVisible();
	});

	test("create-org name step advances to the card-less trial panel", async ({ owner }) => {
		// ownerHobby onboarded on Hobby, so it still holds its one account-wide trial →
		// the name step routes to the trial panel (no Stripe intent, no org created).
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await owner.page.getByPlaceholder(/acme cloud/i).fill(`e2e-switch-${Date.now()}`);
		await owner.page.getByRole("button", { name: /^continue$/i }).click();
		await expect(owner.page.getByRole("button", { name: /start .*free trial/i })).toBeVisible({
			timeout: 15_000,
		});
	});
});

// ── Auth gating on public routes ────────────────────────────────────────────────────

test.describe("Onboarding — auth gating", () => {
	test("/onboarding while logged out redirects to /login", async ({ page }) => {
		await page.goto("/onboarding");
		await page.waitForURL(/\/login/, { timeout: 15_000 });
		await expect(page.getByRole("heading", { name: /log in to alethia/i })).toBeVisible();
	});

	test("/invites/accept with a token while logged out redirects to /login (carrying next)", async ({
		page,
	}) => {
		await page.goto("/invites/accept?token=e2e-fake-token");
		await page.waitForURL(/\/login\?/, { timeout: 15_000 });
		await expect(page).toHaveURL(/next=/);
	});

	test("/invites/accept without a token shows an invalid-invitation message", async ({ page }) => {
		await page.goto("/invites/accept");
		await expect(page.getByRole("heading", { name: /invalid invitation/i })).toBeVisible();
	});

	test("an authed persona is not bounced to /login on its org overview", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

// ── The code step: the resend cooldown ────────────────────────────────────────────

test.describe("Onboarding — the code step", () => {
	/** Drives /signup through the email step only, stopping at the 6-digit code entry. */
	async function toCodeStep(page: Page, email: string): Promise<void> {
		await page.goto("/signup");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await page.locator("#email").fill(email);
		await page.getByRole("button", { name: /continue with email/i }).click();
		await expect(page.getByRole("heading", { name: /enter your code/i })).toBeVisible({
			timeout: 15_000,
		});
	}

	test("the code step names the address the code was sent to", async ({ page }) => {
		const email = freshEmail("codeaddr");
		await toCodeStep(page, email);
		// The address is rendered back, so a typo is correctable before waiting on a mailbox.
		await expect(page.getByText(email, { exact: false })).toBeVisible();
	});

	test("sending a code arms the resend cooldown — disabled, with a live countdown", async ({
		page,
	}) => {
		await toCodeStep(page, freshEmail("cooldown"));

		// THE COUNTDOWN IS ASSERTED, NEVER WAITED OUT. The first cooldown is 30s
		// (RESEND_COOLDOWNS in components/auth/auth-form.tsx) and each resend escalates it to a
		// minute, two, then five — a spec that sat out even the first one would add half a minute
		// of wall clock to the gate to learn something the label already says.
		const cooling = page.getByRole("button", { name: /resend in \d+:\d{2}/i });
		await expect(cooling).toBeVisible();
		await expect(cooling).toBeDisabled();

		// And the enabled form of the control is genuinely absent while the cooldown runs — the
		// half that makes this a cooldown rather than a relabelled button.
		await expect(page.getByRole("button", { name: /^resend code$/i })).toHaveCount(0);
	});
});

// ── The clickwrap gate ────────────────────────────────────────────────────────────

test.describe("Onboarding — the clickwrap gate", () => {
	test("a fresh account is held at /accept-terms until it ticks the box", async ({ page }) => {
		// A signup OTP plus onboarding plus the gate — well past the 30s default.
		test.setTimeout(240_000);
		await freshSignupToOnboarding(page, freshEmail("terms"));
		await page.locator("#org-name").fill(`E2E Terms ${Date.now()}`);
		await page.getByRole("button", { name: /personal projects/i }).click();
		await page.getByRole("button", { name: /create organization/i }).click();

		// Wait for the org hand-off to settle EITHER way before deciding, so the skip below can
		// never fire merely because the navigation had not happened yet.
		await page.waitForURL(
			(url) => url.pathname === "/accept-terms" || isOrgOverview(url),
			{ timeout: 60_000 },
		);
		// Data-dependent: the gate only engages where a legal document is actually awaiting
		// acceptance (app/server/actions/legal.ts · getPendingAcceptance). On a deployment with
		// none, there is nothing to measure — and saying so is the honest outcome, not a pass.
		test.skip(
			new URL(page.url()).pathname !== "/accept-terms",
			"no legal document is pending acceptance on this deployment — the clickwrap gate does not engage",
		);

		// THE PRIVATE-ROUTE HALF. (private)/layout.tsx redirects every route under it back here
		// until the current documents are accepted, so asking for one is the test of the gate —
		// merely being on /accept-terms only says onboarding sent us here.
		await page.goto("/dashboard");
		await expect(page).toHaveURL(/\/accept-terms/);

		// The box starts UNTICKED and the button is inert until it is ticked. That IS the
		// clickwrap; a pre-ticked box is consent that was never given.
		const submit = page.getByRole("button", { name: ACCEPTANCE_LABELS.submit });
		await expect(submit).toBeDisabled();
		await expect(page.getByRole("checkbox")).not.toBeChecked();

		await page
			.getByText(new RegExp(ACCEPTANCE_LABELS.checkboxPrefix, "i"))
			.first()
			.click();
		await expect(submit).toBeEnabled();
		await submit.click();

		// Accepting releases the gate — the account reaches the product.
		await page.waitForURL((url) => url.pathname !== "/accept-terms", { timeout: 60_000 });
		await expect(page).not.toHaveURL(/\/accept-terms/);
	});
});

// ── A second organization, and switching between them ─────────────────────────────

test.describe("Onboarding — a second organization", () => {
	// The `member` persona is the one account in the suite that genuinely belongs to TWO orgs:
	// its own Hobby org from signup, and ownerTeam's org it was invited into (global-setup ·
	// buildMemberPersona). Reading it here is what lets this spec measure "a second org and
	// switching" WITHOUT creating one — creating one would spend ownerHobby's single account-wide
	// trial, which another test in this very file asserts is still available.

	test("the switcher lists both organizations the member belongs to", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}`);
		await member.page.getByRole("button", { name: /switch organization/i }).click();
		await expect(member.page.getByPlaceholder(/find organization/i)).toBeVisible();
		const options = member.page.getByRole("option");
		await expect(options.first()).toBeVisible();
		expect(
			await options.count(),
			"the member owns its own Hobby org and is a member of the team org — the switcher must offer both",
		).toBeGreaterThanOrEqual(2);
	});

	test("picking the other organization navigates to it", async ({ member }) => {
		// An org overview load, a popover, a client-side push and a second org overview load. The
		// 30s default is not a budget for that — it is less than the navigation wait BELOW on its
		// own, so the test died on its own deadline before that wait could ever report (measured on
		// run 34469855618, both attempts `timedOut` with no assertion having failed).
		test.setTimeout(120_000);
		await member.page.goto(`/${member.orgSlug}`);
		const trigger = member.page.getByRole("button", { name: /switch organization/i });
		// The trigger renders the ACTIVE org's name (components/org-switcher.tsx · SwitcherTrigger),
		// which is how the option that is not it can be identified without knowing either name.
		const activeLabel = (await trigger.innerText()).trim();
		await trigger.click();

		const options = member.page.getByRole("option");
		await expect(options.first()).toBeVisible();
		// First line only: each option also renders a plan badge and, for the active one, a check.
		const names = (await options.allInnerTexts()).map((t) => t.split("\n")[0].trim());
		const other = names.findIndex((n) => n.length > 0 && !activeLabel.includes(n));
		expect(
			other,
			`no option distinct from the active org "${activeLabel}" — the switcher offered ${JSON.stringify(names)}`,
		).toBeGreaterThanOrEqual(0);

		await options.nth(other).click();
		// The popover closing is `handleSelect` having RUN; the URL moving is it having chosen a
		// target. Separating them is what tells "the click missed" from "the switch went nowhere"
		// — components/org-switcher.tsx closes and then refuses to navigate for an org with no
		// slug, and a single timeout on the URL cannot tell those two apart.
		await expect(member.page.getByPlaceholder(/find organization/i)).toBeHidden({
			timeout: 15_000,
		});
		// The URL segment is what scopes the request, so the switch is only real once it moves.
		await member.page.waitForURL(
			(url) => {
				const parts = url.pathname.split("/").filter(Boolean);
				return parts.length >= 1 && parts[0] !== member.orgSlug;
			},
			{ timeout: 30_000 },
		);
		await expect(member.page.getByRole("button", { name: /switch organization/i })).toBeVisible();
	});
});

// ── Invitation accept, end to end ─────────────────────────────────────────────────

test.describe("Onboarding — invitation accept", () => {
	test("an invited address signs up, accepts, and gains the inviting org", async ({
		team,
		page,
	}) => {
		// A real invite + a real signup + onboarding + the accept round-trip.
		test.setTimeout(420_000);
		const orgId = team.orgId;
		expect(orgId, "the ownerTeam persona has no resolved org id — global-setup did not finish").toBeTruthy();
		if (!orgId) return;

		// 1. Invite a brand-new address, from the owner's OWN session — the same endpoint the
		//    console's invite dialog calls. Landing on the org first re-syncs the session's active
		//    organization, which `invite-member` reads for scope.
		const invitee = freshEmail("invitee");
		await team.page.goto(`/${team.orgSlug}`, { waitUntil: "domcontentloaded" });
		const invited = await organizationApi(team.page, "invite-member", {
			email: invitee,
			role: "member",
			organizationId: orgId,
		});
		expect(invited.status, `invite-member answered ${invited.status}: ${invited.text}`).toBeLessThan(400);

		// 2. The invitee is a real account before it is anybody's member — signup, onboarding and
		//    the clickwrap, exactly as a person would walk them.
		await signUpHobby(page, invitee);

		/** How many organizations this account's switcher offers right now. */
		async function orgCount(): Promise<number> {
			const trigger = page.getByRole("button", { name: /switch organization/i });
			await expect(trigger).toBeVisible();
			await trigger.click();
			const options = page.getByRole("option");
			await expect(options.first()).toBeVisible();
			const n = await options.count();
			await page.keyboard.press("Escape");
			return n;
		}

		// THE BEFORE. One org — its own. Measured the same way as the after, so the pair is a
		// DIFFERENCE rather than an absolute: "the team org is reachable" would also be true of an
		// account that had been a member all along.
		expect(await orgCount(), "a fresh account belongs to exactly one organization").toBe(1);

		// 3. Accept, through the product's own /invites/accept screen.
		const token = await pendingInvitationId(orgId, invitee);
		expect(token, `no pending invitation row for ${invitee} after a ${invited.status}`).toBeTruthy();
		await page.goto(`/invites/accept?token=${token}`);
		await expect(
			page.getByRole("heading", { name: /you.*ve been invited to an organization/i }),
		).toBeVisible({ timeout: 30_000 });
		await page.getByRole("button", { name: /accept invitation/i }).click();
		await page.waitForURL((url) => !url.pathname.startsWith("/invites"), { timeout: 60_000 });

		// THE AFTER. Two orgs, and the inviting org is reachable by slug.
		await page.goto(`/${team.orgSlug}`);
		await expect(page).toHaveURL(new RegExp(`/${team.orgSlug}(/|$)`));
		expect(await orgCount(), "accepting the invitation adds the inviting organization").toBe(2);
	});
});

// ── The CLI hand-off ──────────────────────────────────────────────────────────────

test.describe("Onboarding — the CLI hand-off", () => {
	test("/cli/login while logged out redirects to /login, carrying the device code", async ({
		page,
	}) => {
		const link = "/cli/login?device_code=11111111-2222-4333-8444-555555555555&user_code=BCDF-GHJK";
		await page.goto(link);
		await page.waitForURL(/\/login\?/, { timeout: 15_000 });
		// `next` must carry the WHOLE original request: proxy.ts preserves the query so signing in
		// returns to an approval screen that still knows which device asked.
		const next = new URL(page.url()).searchParams.get("next") ?? "";
		expect(next, "the login bounce must carry the device_code back").toContain("device_code=");
	});

	test("/cli/login renders the device-authorization screen for a signed-in operator", async ({
		owner,
	}) => {
		await owner.page.goto(
			"/cli/login?device_code=11111111-2222-4333-8444-555555555555&user_code=BCDF-GHJK",
		);
		await expect(owner.page.getByRole("heading", { name: /cli authentication/i })).toBeVisible();
		// The code plate is what the reader character-matches against their terminal.
		await expect(owner.page.locator('[aria-label="Device confirmation code"]')).toContainText(
			"BCDF-GHJK",
		);
		// Refusing is always on offer — /api/auth/cli/deny pre-empts as well as revokes.
		await expect(owner.page.getByRole("button", { name: /this isn.t me/i })).toBeVisible();
	});
});

// ── Signing out ───────────────────────────────────────────────────────────────────

test.describe("Onboarding — signing out", () => {
	test("Log Out ends the session, and a private route then redirects to /login", async ({
		page,
	}) => {
		// A THROWAWAY ACCOUNT, NOT A PERSONA. `authClient.signOut()` revokes the session row, and
		// every persona context in the run is restored from ONE storageState holding ONE token —
		// signing a persona out here would unauthenticate it for every other spec in the suite.
		test.setTimeout(240_000);
		const { orgSlug } = await signUpHobby(page, freshEmail("signout"));

		await page.getByRole("button", { name: /account menu/i }).click();
		await page.getByRole("menuitem", { name: /log ?out/i }).click();

		// Sign-out pushes the console root, which clears the stale cookie (/api/session/reset) and
		// lands on /login rather than trapping the visitor.
		await page.waitForURL(/\/login/, { timeout: 60_000 });
		await expect(page.getByRole("heading", { name: /log in to alethia/i })).toBeVisible();

		// And the org that was reachable a moment ago no longer is.
		await page.goto(`/${orgSlug}`);
		await page.waitForURL(/\/login/, { timeout: 30_000 });
	});
});
