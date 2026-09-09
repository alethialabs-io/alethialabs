// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE POST-DEPLOY SMOKE — ten checks a real browser makes against the PUBLIC console URL.
//
// # Why this exists
//
// The only post-deploy check on production is a 10x `curl` for a 2xx on `/`
// (.github/workflows/deploy-console.yml, "Verifying ${APP_URL} actually serves..."). Anonymous `/`
// is the MARKETING container — deploy/prod/Caddyfile.tunnel stitches the marketing-owned root paths
// at the edge — so a green `/` says the marketing app is up and says NOTHING about the console.
// Two green deploys have already lied: one shipped stale bytes, one served 502 for 20 minutes.
//
// # Why a tsx script and not a Playwright spec
//
// This drives a REMOTE, already-deployed origin. A spec under `e2e/` would be picked up by
// apps/console/playwright.config.ts, whose `webServer` would try to boot a console for it and whose
// `assertNoDeadZone` guard would demand the file belong to a project. Neither is true here: there is
// nothing to boot and no project to join. So it is a plain script on the playwright LIBRARY —
// `@playwright/test` re-exports `chromium`, which is why this needs no new dependency — invoked as
//
//	pnpm -C apps/console run smoke:prod                 # against $SMOKE_BASE_URL
//	pnpm -C apps/console run smoke:prod -- --list       # print the manifest and exit
//	SMOKE_EXPECTED_SHA=<sha> pnpm -C apps/console run smoke:prod
//
// `-C apps/console`, never `-F console`: scripts/ci/check-pnpm-script-refs.mjs refuses `-F <pkg>
// <script>` outside the one recorded exception.
//
// # The manifest is literal, and its length is the contract
//
// {@link CHECKS} is a literal array. `--list` prints its length, and the workflow that calls this
// asserts that number — so a check deleted in a refactor is a red line in CI rather than a quieter
// smoke. This is the same shape as the release gate's `--list` floor guard: a suite that measured
// nothing must not pass as a suite that measured everything.
//
// # The positive controls come first, and they can abort the run
//
// Checks 2, 4 and 5 assert the ABSENCE of console errors and of failed same-origin requests. An
// absence is only evidence if the instrument that would have seen it works — a listener attached to
// the wrong object, or a Playwright version that renamed an event, reports a perfectly clean page
// forever. So check 1 provokes one of each on a throwaway page and requires both to be caught. If
// either does not fire, this prints `::error::checker blind` and exits WITHOUT running the rest:
// a blind run must not be reported as a passing one.
//
// Exit 0 only when every check passed. `smoke-report.json` and one screenshot per failure land in
// `apps/console/smoke-results/`.

import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(import.meta.dirname, "../../smoke-results");


/** A same-origin request the page made, with the status it came back with. */
interface SeenRequest {
	url: string;
	status: number;
}

/** What one page visit observed while it loaded — the evidence checks 2/4/5 read. */
interface Visit {
	page: Page;
	status: number | null;
	consoleErrors: string[];
	failedRequests: SeenRequest[];
}

/** Everything a check is handed. `fail` accumulates; a check may report more than one problem. */
interface Ctx {
	baseUrl: string;
	context: BrowserContext;
	/** Every same-origin request seen across the whole run — check 10's subject. */
	authRequests: string[];
	visit(pathname: string): Promise<Visit>;
	fail(why: string): void;
	note(what: string): void;
}

interface Check {
	/** Stable id, used in the report and in `::error::` lines. */
	id: string;
	name: string;
	run(ctx: Ctx): Promise<void>;
}

/** `https` only. A smoke test that would accept `http://` can be pointed at something it should not trust. */
function requireHttps(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`SMOKE_BASE_URL is not a URL: ${raw}`);
	}
	if (url.protocol !== "https:") {
		throw new Error(
			`refusing a non-https base URL (${url.protocol}//). This drives a PUBLIC deploy; ` +
				`plaintext would make every assertion below trivially forgeable.`,
		);
	}
	return url.origin;
}

/**
 * A slug no organisation can be sitting on.
 *
 * Check 9 asks what an anonymous visitor gets for an org that does not exist, so the answer must not
 * depend on who happens to have signed up. A fixed string would eventually be claimed.
 */
const NONEXISTENT_ORG = `smoke-no-such-org-${Date.now().toString(36)}`;

/**
 * A path that really does 404 on this deploy — the positive control for the failed-request listener.
 *
 * It has to be under `/_next/static/`, and that is not a detail. The console owns the residual
 * `/{org}` wildcard (apps/console/next.config.ts), so an arbitrary path is an ORG LOOKUP, not a
 * miss: `/__anything__` and even `/api/__anything__` answer **307** to `/login`, which the browser
 * follows to a 200. Measured against production — the first draft of this control used a bare
 * `/__smoke_control_404__`, the listener correctly saw no 4xx, and the run aborted itself as blind.
 * That is the abort working, but on a control that could never have fired.
 */
const CONTROL_404 = "/_next/static/__smoke_control_404__.js";

/** The four OAuth tiles `components/auth/auth-form.tsx` renders unconditionally, by accessible name. */
const OAUTH_TILES = ["GitHub", "Google", "GitLab", "Bitbucket"];

/**
 * THE MANIFEST. One entry per check; the length is what `--list` prints and the workflow asserts.
 */
const CHECKS: Check[] = [
	{
		id: "controls",
		name: "positive controls — the console-error and failed-request listeners both fire",
		// Handled specially by `main`: a failure here aborts, because every later absence assertion
		// depends on these two listeners working.
		async run(ctx) {
			const v = await ctx.visit("/");
			await v.page.evaluate(() => {
				console.error("__smoke_control__ this line is deliberate");
			});
			await v.page
				.evaluate((probe: string) => fetch(probe).catch(() => undefined), CONTROL_404)
				.catch(() => undefined);
			// Give the response event a turn to land before reading the evidence.
			await v.page.waitForTimeout(500);

			const sawConsole = v.consoleErrors.some((l) => l.includes("__smoke_control__"));
			const sawFailure = v.failedRequests.some((r) => r.url.includes(CONTROL_404));
			if (!sawConsole) ctx.fail("the console-error listener did not see a deliberate console.error");
			if (!sawFailure) {
				ctx.fail("the failed-request listener did not see a deliberate same-origin 404");
			}
			if (sawConsole && sawFailure) ctx.note("both listeners fired");
			await v.page.close();
		},
	},
	{
		id: "root",
		name: "/ returns 200, renders an h1, and is clean",
		async run(ctx) {
			const v = await ctx.visit("/");
			if (v.status !== 200) ctx.fail(`/ returned ${v.status}, expected 200`);
			const h1 = await v.page.locator("h1").first().textContent().catch(() => null);
			if (!h1 || !h1.trim()) ctx.fail("/ rendered no non-empty <h1>");
			else ctx.note(`h1: ${JSON.stringify(h1.trim().slice(0, 60))}`);
			assertClean(ctx, v, "/");
			await v.page.close();
		},
	},
	{
		id: "nav-context",
		name: "/api/nav-context reports an anonymous visitor",
		async run(ctx) {
			const res = await ctx.context.request.get(`${ctx.baseUrl}/api/nav-context`);
			if (res.status() !== 200) ctx.fail(`/api/nav-context returned ${res.status()}, expected 200`);
			const body = await res.json().catch(() => null);
			if (!body || body.authenticated !== false) {
				ctx.fail(`/api/nav-context said ${JSON.stringify(body)}, expected authenticated:false`);
			} else {
				ctx.note("authenticated:false");
			}
		},
	},
	{
		id: "login",
		name: "/login offers email + every OAuth tile, and is clean",
		async run(ctx) {
			await assertAuthPage(ctx, "/login");
		},
	},
	{
		id: "signup",
		name: "/signup offers email + every OAuth tile, and is clean",
		async run(ctx) {
			await assertAuthPage(ctx, "/signup");
		},
	},
	{
		id: "docs",
		name: "/docs returns 200 with a non-empty title",
		async run(ctx) {
			const v = await ctx.visit("/docs");
			if (v.status !== 200) ctx.fail(`/docs returned ${v.status}, expected 200`);
			const title = (await v.page.title()).trim();
			if (!title) ctx.fail("/docs rendered an empty <title>");
			else ctx.note(`title: ${JSON.stringify(title.slice(0, 60))}`);
			await v.page.close();
		},
	},
	{
		id: "health",
		name: "/api/health — shallow is ok, deep is healthy",
		async run(ctx) {
			const shallow = await ctx.context.request.get(`${ctx.baseUrl}/api/health?shallow=1`);
			const shallowBody = await shallow.json().catch(() => null);
			if (shallowBody?.status !== "ok") {
				ctx.fail(`/api/health?shallow=1 said ${JSON.stringify(shallowBody)}, expected status:ok`);
			} else {
				ctx.note("shallow: ok");
			}

			const deep = await ctx.context.request.get(`${ctx.baseUrl}/api/health`);
			const deepBody = await deep.json().catch(() => null);
			// The route's own contract: 503 only when `unhealthy`; `degraded` stays 200 so a shared
			// degradation cannot cascade a load balancer into an outage. This mirrors that — a
			// degraded console is a WARNING here, because failing the deploy on it would take the
			// site down for the thing the route deliberately refuses to take the site down for.
			if (deep.status() === 503 || deepBody?.status === "unhealthy") {
				ctx.fail(`/api/health is unhealthy (HTTP ${deep.status()}): ${JSON.stringify(deepBody)}`);
			} else if (deepBody?.status === "degraded") {
				console.log(`::warning::/api/health reports DEGRADED: ${JSON.stringify(deepBody)}`);
				ctx.note("deep: degraded (warning, not a failure)");
			} else if (deepBody?.status !== "healthy") {
				ctx.fail(`/api/health said ${JSON.stringify(deepBody)}, expected healthy`);
			} else {
				ctx.note("deep: healthy");
			}
		},
	},
	{
		id: "build-id",
		name: "the served build id equals the promoted SHA",
		// THE CHECK THAT CATCHES A STALE DEPLOY. `NEXT_PUBLIC_APP_VERSION` is set from the deploy SHA
		// in apps/console/Dockerfile and reaches the browser through next-runtime-env's
		// `<PublicEnvScript />` (apps/console/app/layout.tsx), which writes `window.__ENV`. Reading it
		// from the BROWSER is the point: a value read server-side would report the file the host
		// currently holds, which is exactly what is already correct when this fails.
		async run(ctx) {
			const expected = process.env.SMOKE_EXPECTED_SHA?.trim();
			const v = await ctx.visit("/");
			// No local `declare global` and no cast. `next-runtime-env` already declares
			// `Window.__ENV: NodeJS.ProcessEnv`, so re-declaring it is TS2717/TS2687 (a different
			// type and different modifiers) and a `window as …` cast is a lint error —
			// `eslint.config.mjs` sets `assertionStyle: "never"` outside `tests/**` and `e2e/**`,
			// and `scripts/e2e/**` is not that `e2e/`. The optional chain stays because the script
			// tag genuinely may not have rendered, which is a state this check must observe rather
			// than crash on.
			const served = await v.page.evaluate(
				() => window.__ENV?.NEXT_PUBLIC_APP_VERSION ?? null,
			);
			if (!expected) {
				// Not every deploy moves the console image. Saying so is honest; inventing a pass is not.
				ctx.note(`NOT ASSERTED (apps unchanged) — served build id is ${served ?? "unset"}`);
			} else if (served !== expected) {
				ctx.fail(
					`the browser is running build ${served ?? "unset"}, but ${expected} was promoted — ` +
						`stale bytes are being served`,
				);
			} else {
				ctx.note(`build ${served}`);
			}
			await v.page.close();
		},
	},
	{
		id: "signed-out",
		name: "signed-out routes redirect to /login",
		async run(ctx) {
			const dash = await ctx.visit("/dashboard");
			const dashUrl = new URL(dash.page.url());
			if (dashUrl.pathname !== "/login" || dashUrl.searchParams.get("next") !== "/dashboard") {
				ctx.fail(`/dashboard landed on ${dash.page.url()}, expected /login?next=%2Fdashboard`);
			} else {
				ctx.note("/dashboard -> /login?next=%2Fdashboard");
			}
			await dash.page.close();

			const org = await ctx.visit(`/${NONEXISTENT_ORG}`);
			if (new URL(org.page.url()).pathname !== "/login") {
				ctx.fail(`/${NONEXISTENT_ORG} landed on ${org.page.url()}, expected /login`);
			} else {
				ctx.note(`/<nonexistent-org> -> /login`);
			}
			await org.page.close();
		},
	},
	{
		id: "self-guard",
		name: "the run itself touched no auth endpoint but get-session",
		// A smoke test that signs in, or trips a sign-in side effect, stops being a smoke test and
		// starts being a thing that can lock an account out or burn an OTP against production. The
		// only /api/auth/ traffic an anonymous page load may produce is the session read.
		async run(ctx) {
			const offenders = ctx.authRequests.filter((u) => !u.includes("get-session"));
			if (offenders.length > 0) {
				ctx.fail(
					`the run made ${offenders.length} non-get-session auth request(s): ` +
						`${[...new Set(offenders)].slice(0, 5).join(", ")}`,
				);
			} else {
				ctx.note(`${ctx.authRequests.length} auth request(s), all get-session`);
			}
		},
	},
];

/** Checks 2/4/5's shared "and is clean" half: no console errors, no failed same-origin requests. */
function assertClean(ctx: Ctx, v: Visit, where: string): void {
	if (v.consoleErrors.length > 0) {
		ctx.fail(`${where} logged ${v.consoleErrors.length} console error(s): ${v.consoleErrors[0]}`);
	}
	if (v.failedRequests.length > 0) {
		const first = v.failedRequests[0];
		ctx.fail(
			`${where} made ${v.failedRequests.length} failing same-origin request(s), e.g. ` +
				`${first.status} ${first.url}`,
		);
	}
}

/** `/login` and `/signup` render the same form in two modes, so they are asserted identically. */
async function assertAuthPage(ctx: Ctx, pathname: string): Promise<void> {
	const v = await ctx.visit(pathname);
	if (v.status !== 200) ctx.fail(`${pathname} returned ${v.status}, expected 200`);
	// The accessible name is pinned in auth-form.tsx ("has to stay exactly 'Continue with email'").
	const email = v.page.getByRole("button", { name: "Continue with email" });
	if ((await email.count()) === 0) ctx.fail(`${pathname} has no "Continue with email" button`);
	for (const tile of OAUTH_TILES) {
		const btn = v.page.getByRole("button", { name: new RegExp(`^${tile}`, "i") });
		if ((await btn.count()) === 0) ctx.fail(`${pathname} is missing the ${tile} sign-in tile`);
	}
	assertClean(ctx, v, pathname);
	await v.page.close();
}

/**
 * Opens a page with both listeners already attached, navigates, and returns what it saw.
 *
 * The listeners go on BEFORE `goto` deliberately: attached afterwards they would miss every error
 * and every request the initial load produced, which is most of them.
 */
function makeVisit(context: BrowserContext, baseUrl: string, authRequests: string[]) {
	return async function visit(pathname: string): Promise<Visit> {
		const page = await context.newPage();
		const consoleErrors: string[] = [];
		const failedRequests: SeenRequest[] = [];

		page.on("console", (msg) => {
			if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
		});
		page.on("response", (res) => {
			const url = res.url();
			if (!url.startsWith(baseUrl)) return; // third-party noise is not this deploy's problem
			if (url.includes("/api/auth/")) authRequests.push(url);
			if (res.status() >= 400) failedRequests.push({ url, status: res.status() });
		});

		const res = await page.goto(`${baseUrl}${pathname}`, {
			waitUntil: "domcontentloaded",
			timeout: 30_000,
		});
		await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
		return { page, status: res?.status() ?? null, consoleErrors, failedRequests };
	};
}

interface Result {
	id: string;
	name: string;
	failures: string[];
	notes: string[];
}

async function main(argv: string[]): Promise<number> {
	if (argv.includes("--list")) {
		console.log(`post-deploy smoke — ${CHECKS.length} checks:`);
		CHECKS.forEach((c, i) => console.log(`  ${i + 1}. ${c.id} — ${c.name}`));
		return 0;
	}

	const baseUrl = requireHttps(process.env.SMOKE_BASE_URL ?? "https://alethialabs.io");
	console.log(`post-deploy smoke — ${CHECKS.length} checks against ${baseUrl}`);

	fs.mkdirSync(OUT_DIR, { recursive: true });
	const results: Result[] = [];
	let browser: Browser | undefined;

	try {
		browser = await chromium.launch();
		const context = await browser.newContext({ ignoreHTTPSErrors: false });
		const authRequests: string[] = [];
		const visit = makeVisit(context, baseUrl, authRequests);

		for (const check of CHECKS) {
			const result: Result = { id: check.id, name: check.name, failures: [], notes: [] };
			const ctx: Ctx = {
				baseUrl,
				context,
				authRequests,
				visit,
				fail: (why) => result.failures.push(why),
				note: (what) => result.notes.push(what),
			};
			try {
				await check.run(ctx);
			} catch (err) {
				result.failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
			}
			results.push(result);

			if (result.failures.length === 0) {
				console.log(`  ✓ ${check.id} — ${result.notes.join("; ") || "ok"}`);
			} else {
				for (const f of result.failures) console.log(`::error::${check.id}: ${f}`);
				await screenshot(context, check.id);
			}

			// THE ABORT. Every later "and is clean" assertion is an absence, and an absence measured
			// by a broken instrument is indistinguishable from a pass.
			if (check.id === "controls" && result.failures.length > 0) {
				console.log(
					"::error::checker blind — the positive controls did not fire, so every later " +
						"absence assertion would be vacuous. Refusing to report on this deploy.",
				);
				return 1;
			}
		}
		await context.close();
	} finally {
		await browser?.close();
		fs.writeFileSync(
			path.join(OUT_DIR, "smoke-report.json"),
			`${JSON.stringify({ baseUrl, at: new Date().toISOString(), results }, null, 2)}\n`,
		);
	}

	const failed = results.filter((r) => r.failures.length > 0);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed against ${baseUrl}`);
	if (failed.length > 0) console.log(`failed: ${failed.map((r) => r.id).join(", ")}`);
	return failed.length > 0 ? 1 : 0;
}

/** One screenshot per failed check, best-effort — a screenshot that throws must not mask the failure. */
async function screenshot(context: BrowserContext, id: string): Promise<void> {
	const page = context.pages().at(-1);
	if (!page) return;
	await page.screenshot({ path: path.join(OUT_DIR, `${id}.png`), fullPage: true }).catch(() => undefined);
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((err) => {
		console.log(`::error::post-deploy smoke: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
