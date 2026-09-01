// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T7 — "as the `member` persona, a forbidden page renders a deliberate state, not a blank."
//
// The persona has to be REAL. There is no `member` persona anywhere in this repo today
// (`e2e/global-setup.ts` says so in a comment: it creates ownerHobby and, best-effort, ownerTeam,
// and leaves member "for a later step"), so this spec builds one — and it builds it through the
// PRODUCT'S OWN endpoints, better-auth's organization plugin, the same ones the invite dialog
// calls, from two real cookie-bearing browser contexts. Nothing is written straight into `member`:
// a raw row would skip whatever the accept path does to provision access, and the persona would
// then be denied EVERYWHERE for a reason that has nothing to do with roles.
//
// TWO THINGS THIS RAN INTO, both measured:
//
//   · **Inviting is a PAID feature, enforced at the endpoint.** `app/api/auth/[...all]/route.ts`
//     gates `invite-member` on the `organizations` entitlement, so a fresh Hobby org gets
//     `403 upgrade_required` — not from the dialog, from the API. So the fixture grants this org's
//     billing record `plan=team, status=active` first. That is a fixture, not a bypass: the gate
//     itself is exercised (an unentitled org really is refused, which is how this was found), and
//     the audit's own org is untouched — T7 works in an org of its OWN, created here, so the
//     empty-org pass in `routes.spec.ts` cannot be disturbed by a plan change or by a second member.
//
//   · **A member with NO access renders the org's 404 on every route**, every one of those is
//     "a deliberate state", and T7 would report a column of PASSes while measuring nothing about
//     permissions. So the run asserts FIRST that the persona can load a route normally. If it
//     cannot, the instrument is broken and this spec says so instead of scoring.
//
// And for the same reason RESTRICTION IS MEASURED AS A DIFFERENCE. Every route is driven twice —
// once as the member, once as the OWNER of the same org — and a route counts as restricted only
// where the two disagree. A redirect on its own proves nothing: `/dashboard` and `~/settings`
// redirect every caller, so reading "the member was bounced" as refusal scored T7 PASS on routes
// that restrict nobody.

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { closeDb, db, orgIdBySlug } from "../helpers/db";
import { signUpWithOtp } from "../fixtures/auth";
import { materialize, needsOnlyOrg, type AuditContext } from "./context";
import { consoleRoutes } from "./manifest";
import { rendersSharedErrorState, visibleText } from "./error-state";
import { createReport } from "./report";

const manifest = consoleRoutes();
const ctx: AuditContext = { orgSlug: "", owner: { userId: "", orgId: "" } };
// This spec's OWN verdict buffer — see report.ts on why it must not be module state.
const report = createReport();
const record = report.record;

let memberContext: BrowserContext | null = null;
let memberPage: Page | null = null;
let memberEmail = "";
// The OWNER stays open for the whole spec. T7's question is comparative — see `observe` below —
// and answering it needs the same route driven by somebody who is not the member.
let ownerContext: BrowserContext | null = null;
let ownerPage: Page | null = null;

/**
 * Signs an account up, retrying the whole walk — WITH A FRESH ADDRESS EACH TIME.
 *
 * `signUpWithOtp` waits 5s for the consent banner and 30s for the OTP, and on a contended runner
 * the first of those is genuinely tight; `e2e/global-setup.ts` wraps every persona in the same
 * shape for the same reason ("transient recompile 500s, slow OTP"). A T7 persona that fails to be
 * born takes the whole predicate with it.
 *
 * THE ADDRESS MUST CHANGE PER ATTEMPT, and this is not tidiness. `signUpWithOtp` creates the
 * account at OTP verification and then still has to walk onboarding, the clickwrap and the org
 * hand-off. A failure in any of those — precisely the transient case the retry exists for — leaves
 * a REAL account behind. Retried on the same address the flow is a SIGN-IN, `/onboarding` never
 * appears, and the fixture's `waitForURL(/\/onboarding/)` times out after 30s. Every later attempt
 * is then guaranteed to fail, and the run spends two 35s sleeps and two 30s timeouts proving it
 * inside a 180s test budget. So the caller gets back the address that actually worked.
 */
async function signUpWithRetry(
	page: Page,
	emailFor: (attempt: number) => string,
	attempts = 3,
): Promise<{ email: string; orgSlug: string }> {
	let last: unknown;
	for (let i = 1; i <= attempts; i++) {
		const email = emailFor(i);
		try {
			const { orgSlug } = await withTestEmail(email, () => signUpWithOtp(page));
			return { email, orgSlug };
		} catch (err) {
			last = err;
			const why = err instanceof Error ? err.message : String(err);
			// WHERE it stopped, not just that it did. A bare "locator timed out" sends the reader to
			// the locator; the URL and the first line of the page say whether the walk was on the
			// signup form at all — which is how the "already signed in, so /signup redirected"
			// case tells itself apart from "the consent button was renamed".
			const where = await page
				.evaluate(() => `${location.pathname} :: ${document.body.innerText.trim().slice(0, 160)}`)
				.catch(() => "(page unreadable)");
			console.warn(`[audit/T7] signup ${email} attempt ${i}/${attempts}: ${why}\n    at ${where}`);
			await page.context().clearCookies();
			// 35s, not 2s. Better Auth caps OTP issuance at 5 sends / 60s per IP
			// (`lib/config/auth.ts`), and a retry inside that window gets "Too many requests" and
			// burns an attempt without ever asking for a code. Measured: three attempts, 2s apart,
			// all three refused by the rate limiter.
			await page.waitForTimeout(35_000);
		}
	}
	throw last;
}

/**
 * Runs `fn` with `signUpWithOtp` pointed at `email`.
 *
 * `fixtures/auth.ts` reads `TEST_USER_EMAIL` and otherwise invents an address. Setting it around
 * the call is how this spec reuses the whole vetted signup walk — consent, OTP, onboarding, the
 * clickwrap — for an address it has to choose, instead of writing a second copy of it that would
 * drift the first time the gate changes.
 */
async function withTestEmail<T>(email: string, fn: () => Promise<T>): Promise<T> {
	const prior = process.env.TEST_USER_EMAIL;
	process.env.TEST_USER_EMAIL = email;
	try {
		return await fn();
	} finally {
		if (prior === undefined) delete process.env.TEST_USER_EMAIL;
		else process.env.TEST_USER_EMAIL = prior;
	}
}

/**
 * Calls a better-auth organization endpoint from inside the page, so the request carries the
 * session cookie exactly as the console's own client does.
 */
async function authApi(page: Page, endpoint: string, body: unknown): Promise<{ status: number; text: string }> {
	return page.evaluate(
		async ([path, payload]) => {
			const res = await fetch(`/api/auth/organization/${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			return { status: res.status, text: (await res.text()).slice(0, 400) };
		},
		[endpoint, body] as const,
	);
}

test.beforeAll(async ({ browser }, testInfo) => {
	// `storageState: undefined` is LOAD-BEARING, and it is the opposite of what the API reads like.
	// Playwright's `browser` fixture applies the project's `use` to every context made through it,
	// so `browser.newContext()` here inherits the audit project's `storageState` — the audit
	// PERSONA's session. Measured: the T7 owner signup opened `/signup` and was redirected straight
	// into the persona's org, already signed in, so the consent step never appeared; three retries
	// later it invited from the WRONG org and got a 403 for an entitlement the fixture had granted
	// to a different one. Clearing it is what makes this a genuinely new account.
	const baseURL = testInfo.project.use.baseURL;
	// An org of its OWN, not the audit persona's: T7 needs a paid plan and a second member, and
	// both would change what `routes.spec.ts` measures on the org it deliberately keeps empty.
	ownerContext = await browser.newContext({ baseURL, storageState: undefined });
	// A local binding as well as the module-level one: the module-level `ownerPage` is nullable
	// (T7's per-route comparison reads it), and narrowing it once here keeps the setup readable.
	const asOwner = await ownerContext.newPage();
	ownerPage = asOwner;
	{
		const stamp = Date.now();
		const owner = await signUpWithRetry(asOwner, (i) => `e2e-audit-owner-${stamp}-${i}@alethia.test`);
		ctx.orgSlug = owner.orgSlug;
		const orgId = await orgIdBySlug(ctx.orgSlug);
		expect(orgId, `no organization row for "${ctx.orgSlug}"`).toBeTruthy();
		if (!orgId) return;
		ctx.owner.orgId = orgId;

		// The paid-plan fixture. `resolveEntitlements` reads the org's billing record and only
		// `trialing`/`active` grant the plan's entitlements, so anything less leaves the invite
		// endpoint returning 403 and T7 unmeasurable.
		await db()`
			insert into organization_billing (organization_id, plan, status)
			values (${orgId}, 'team', 'active')
			on conflict (organization_id) do update set plan = 'team', status = 'active'`;
		const granted = await db()<{ plan: string; status: string }[]>`
			select plan, status from organization_billing where organization_id = ${orgId}`;
		expect(granted[0], `no organization_billing row for ${orgId} after the grant`).toBeTruthy();
		// Best-effort, and deliberately NOT asserted: this build answers 404 on
		// `organization/set-active`, and it does not matter — a freshly onboarded account has
		// exactly one membership, and `[org]/layout.tsx` re-syncs the session's active org to the
		// `{org}` segment on every request anyway. Asserted, it would fail the whole predicate for
		// a call that changes nothing.
		await authApi(asOwner, "set-active", { organizationId: orgId });

		// THE INVITEE SIGNS UP FIRST, then is invited at whatever address it ended up with. The
		// other order coupled the invitation to an address chosen before the signup ran, so a retry
		// that (correctly) minted a fresh one would have invited an account that does not exist.
		memberContext = await browser.newContext({ baseURL, storageState: undefined });
		const invitee = await memberContext.newPage();
		memberPage = invitee;
		const member = await signUpWithRetry(invitee, (i) => `e2e-audit-member-${stamp}-${i}@alethia.test`);
		memberEmail = member.email;

		const invited = await authApi(asOwner, "invite-member", {
			email: memberEmail,
			role: "member",
			organizationId: orgId,
		});
		expect(
			invited.status,
			`inviting the member persona failed (${invited.status}): ${invited.text}\n` +
				`  org ${ctx.orgSlug} (${orgId}) billing=${JSON.stringify(granted[0])}\n` +
				`  A 403 "upgrade_required" WITH a team/active billing row means the console resolved\n` +
				`  COMMUNITY entitlements, which happens when it did not load @alethia/ee: without the\n` +
				`  enterprise module lib/auth/scope.ts falls back to { orgId: userId }, an org with no\n` +
				`  billing record. Build it (\`pnpm -F @alethia/ee build\`) and restart the console. Note\n` +
				`  that ee/dist is gitignored, so an rsync-based deploy can delete it — measured on a\n` +
				`  sandbox env, where \`pnpm env:push\` left the console silently in community scope.\n` +
				`  T7 cannot be measured without a member — do not let this become a skipped predicate.`,
		).toBeLessThan(400);

		// Not `helpers/db.ts:pendingInvitationId` — it quotes `"organizationId"`, and the real column
		// is `organization_id` (the drizzle instance maps the schema's camelCase keys through
		// `casing: "snake_case"`), so that helper throws on every call. Flagged; out of scope here.
		const pending = await db()<{ id: string }[]>`
			select id from invitation
			where organization_id = ${orgId} and email = ${memberEmail} and status = 'pending'
			order by created_at desc limit 1`;
		const invitationId = pending[0]?.id ?? null;
		expect(invitationId, `no pending invitation for ${memberEmail} in ${orgId}`).toBeTruthy();
		const accepted = await authApi(invitee, "accept-invitation", { invitationId });
		expect(accepted.status, `accepting the invitation failed (${accepted.status}): ${accepted.text}`).toBeLessThan(400);
		// Same: best-effort. The member now belongs to two orgs, and the org layout resolves the
		// scope from the URL segment, so the routes below are driven in the audited org regardless.
		await authApi(invitee, "set-active", { organizationId: orgId });

		const role = await db()<{ role: string }[]>`
			select role from member
			where organization_id = ${orgId} and user_id = (select id from "user" where email = ${memberEmail})`;
		expect(role[0]?.role, `${memberEmail} is not a member row in ${orgId}`).toBeTruthy();
	}
});

test.afterAll(async () => {
	await memberContext?.close();
	await ownerContext?.close();
	report.write(ctx.orgSlug, "ui-audit-permissions.json");
	await closeDb();
});

/** What a persona sees on a route: the content region, reduced to the things T7 asks about. */
interface Observation {
	path: string;
	text: string;
	length: number;
	sharedErrorState: boolean;
	sharedEmpty: boolean;
	denialCopy: boolean;
}

async function observe(page: Page): Promise<Observation> {
	const sharedErrorState = await rendersSharedErrorState(page);
	// `visibleText` (innerText), NOT textContent: the document carries tens of kilobytes of inline
	// script source, so a textContent-based "is this blank?" answers "no" for a genuinely blank
	// page — which is the entire question T7 asks. Measured, see e2e/audit/error-state.ts.
	const text = await visibleText(page);
	const sharedEmpty = await page.evaluate(
		() => !!(document.querySelector("main") ?? document.body).querySelector('[data-slot="empty"]'),
	);
	return {
		path: new URL(page.url()).pathname,
		text: text.slice(0, 240),
		length: text.length,
		sharedEmpty,
		sharedErrorState,
		denialCopy:
			// NOT a bare /permission/: `~/settings/roles` is a page ABOUT permissions and says the
			// word all over its ordinary content, so the loose form would read a page the member is
			// fully allowed to see as a refusal — and then score T7 PASS on it.
			/(don'?t have (access|permission)|do not have (access|permission)|not authori[sz]ed|no permission|forbidden|403|not found|404|ask an (owner|admin))/i.test(
				text,
			),
	};
}

/** Loads `url` in `page` and reports what a person would see there. */
async function visit(page: Page, url: string): Promise<Observation> {
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
	return observe(page);
}

test("the member persona really is a member — otherwise T7 measures the org 404, not permissions", async () => {
	expect(memberPage, "no member page was created").not.toBeNull();
	if (!memberPage) return;
	const seen = await visit(memberPage, `/${ctx.orgSlug}`);
	expect(
		seen.path.startsWith(`/${ctx.orgSlug}`),
		`the member was bounced off the org overview to ${seen.path} — it has no access to the ` +
			`audited org at all, so every T7 verdict below would be about the org 404. Fix the ` +
			`invitation path before believing any T7 number.`,
	).toBe(true);
	expect(
		seen.sharedErrorState || seen.denialCopy,
		`the org overview rendered a denial for a member: "${seen.text}"`,
	).toBe(false);
});

test.describe("T7 · what the member persona gets on each route", () => {
	for (const route of manifest.routes.filter(needsOnlyOrg)) {
		test(`${route.route}`, async () => {
			expect(memberPage).not.toBeNull();
			if (!memberPage) return;
			// A redirect-only route has no surface to restrict: it exists to send the caller
			// somewhere else, and reading that redirect as "the member was refused" would score a
			// T7 PASS on the product working normally.
			if (route.isRedirectOnly) {
				record({
					route: route.route,
					url: materialize(route, ctx),
					predicate: "T7",
					verdict: "N/A",
					reason: "no-restricted-surface",
					evidence: { redirectOnly: true },
				});
				return;
			}
			const url = materialize(route, ctx);
			const seen = await visit(memberPage, url);

			// RESTRICTION IS A DIFFERENCE, NOT A REDIRECT.
			//
			// The first version read "the member was redirected" as evidence of refusal on its own,
			// and that scores a PASS on routes that redirect EVERYONE: `/dashboard` is the app's
			// "where do I belong" hop (JSX beside its `redirect()`, so `isRedirectOnly` does not
			// catch it) and `~/settings` sends every caller to its default tab. Both bounced the
			// member, both were recorded restricted-and-deliberate, and T7 reported green over a
			// route that restricted nothing — the exact column-of-PASSes failure this file's header
			// warns about.
			//
			// So the same URL is driven by the OWNER of the same org, and only a difference counts:
			// the member ends up somewhere the owner does not, or sees a denial the owner does not.
			const byOwner = ownerPage ? await visit(ownerPage, url) : null;
			const memberRedirected = !seen.path.startsWith(url.replace(/\/$/, ""));
			const ownerRedirectedSameWay = byOwner !== null && byOwner.path === seen.path;
			const redirectedAway = memberRedirected && !ownerRedirectedSameWay;
			const deniedWhereOwnerIsNot =
				(seen.sharedErrorState && !(byOwner?.sharedErrorState ?? false)) ||
				(seen.denialCopy && !(byOwner?.denialCopy ?? false));
			const restricted = redirectedAway || deniedWhereOwnerIsNot;
			const evidence = { member: seen, owner: byOwner, redirectedAway, deniedWhereOwnerIsNot };

			if (!restricted) {
				record({
					route: route.route,
					url,
					predicate: "T7",
					verdict: "N/A",
					reason: "no-restricted-surface",
					evidence,
				});
				return;
			}
			// A blank is never a deliberate state — that is the whole of T7.
			const deliberate = redirectedAway || seen.sharedErrorState || seen.sharedEmpty || seen.length >= 20;
			record({
				route: route.route,
				url,
				predicate: "T7",
				verdict: deliberate ? "PASS" : "FAIL",
				evidence,
			});
			expect(
				deliberate,
				`T7 ${route.route}: the member is refused this page and it renders a BLANK ` +
					`(${seen.length} characters in <main>), not a state.`,
			).toBe(true);
		});
	}
});
