// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// THE DESTRUCTIVE-ACTION SPEC — the live half of #4266.
//
// `apps/console/destructive-actions.yaml` records, for every control that destroys something, what
// stands between the click and the mutation. `scripts/check-destructive-actions.mjs` proves the
// ledger and the tree name the same set of call sites. This proves the CONFIRMATIONS are real:
// it opens each control, asserts the confirmation the entry declares, presses **Cancel**, and then
// proves nothing was destroyed — twice over, by two independent observations.
//
// ── IT NEVER PRESSES A CONFIRM ──────────────────────────────────────────────────────────────────
//
// The only button this file ever clicks inside a dialog is Cancel. `confirm_action` is read so the
// destructive button can be FOUND and asserted; it is never activated. That is not a convention to
// remember — `assertNeverPressed()` below fails the test if the located confirm button is ever the
// click target, so the rule is enforced rather than trusted.
//
// ── "NOTHING MUTATED", TWO WAYS ─────────────────────────────────────────────────────────────────
//
// One observation is not enough, because each is blind in a different direction:
//
//   1. A REQUEST deny-list. Every request the page issues while the dialog is open is recorded; a
//      non-GET to the route (a Next server action posts to the current URL with a `Next-Action`
//      header) or to the entry's fetch path is a finding. This catches a mutation that fired
//      optimistically on open — but it cannot see one that already happened before the listener
//      attached.
//   2. A DATABASE fingerprint. Row counts across every public table, before and after. This catches
//      a mutation however it travelled — but it cannot tell an update from a no-op.
//
// A control that mutated on open fails (1); a control that mutated by some path the listener does
// not model fails (2). Requiring both is what makes "nothing happened" a measurement rather than an
// absence of evidence.
//
// ── A WITHHELD VERDICT IS NOT A PASS ────────────────────────────────────────────────────────────
//
// A control the run could not reach — its fixture is not seedable in this environment, its route
// does not materialise, the trigger is not rendered for the persona — is recorded as
// `not-measured` WITH ITS REASON, never as a silent pass. That distinction is this repo's most
// expensive recurring defect, so it is made twice: `test-results/destructive.json` carries the
// reason per control, and the LAST test in the file fails when fewer than `MIN_MEASURED` controls
// were actually driven. A suite whose fixtures all quietly stopped seeding would otherwise report
// 46 green tests having asserted nothing.
//
// ⚠ `MIN_MEASURED` is 1 on this first landing and that is deliberately weak: the honest number is
// the one the FIRST REAL RUN produces, and a floor invented before the measurement would be a
// number nobody could defend. Raise it to the observed count in this PR once the gate has run —
// the run's step summary prints it — and treat any later fall as the finding it is.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

import { db, closeDb } from "../helpers/db";
import { restoreContext, materialize, resolveOrgSlug, resolveOwner, saveContext, seedRouteFixtures, type AuditContext } from "./context";
import { consoleRoutes } from "./manifest";

// ── the ledger, through the census's reader ─────────────────────────────────────────────────────

interface ControlEntry {
	id: string;
	route: string;
	surface: string;
	mutation: string;
	mutation_surface?: string;
	reach?: { menu?: string; section?: string; select?: string; open?: string }[];
	control?: { role?: string; name?: string };
	confirm?: string;
	confirm_action?: string;
	dialog_title?: string;
	fixture?: string;
	persona?: string;
	status?: string;
	issue?: string;
	"prod-qa"?: string;
	reason?: string;
}

/**
 * The registry, read by the census script in a subprocess.
 *
 * A subprocess rather than an import, following `manifest.ts`'s reading of `console-routes.mjs`: a
 * Playwright spec and a repo `.mjs` do not share a module system, and a second hand-rolled reader
 * of one list is precisely the disagreement the registry exists to prevent.
 *
 * It RAISES rather than returning `[]`. A suite that runs zero controls and a suite whose ledger
 * failed to load are the same colour otherwise.
 */
function registry(): ControlEntry[] {
	const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");
	const seam = path.join(repoRoot, "scripts", "check-destructive-actions.mjs");
	let raw: string;
	try {
		raw = execFileSync(process.execPath, [seam, "--registry-json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	} catch (err) {
		throw new Error(`the destructive-action registry could not be read — this spec has no denominator and MUST NOT run over an assumed one.\n  seam: ${seam}\n  ${String(err)}`);
	}
	const parsed = JSON.parse(raw) as { controls?: ControlEntry[] };
	if (!Array.isArray(parsed.controls) || parsed.controls.length === 0) {
		throw new Error(`${seam} --registry-json produced no controls`);
	}
	return parsed.controls;
}

const CONTROLS = registry();

/** See the ⚠ above. Raise from the first real run; a fall is a finding. */
const MIN_MEASURED = 1;

// ── the record ──────────────────────────────────────────────────────────────────────────────────

type Observed = "confirmed" | "missing" | "inert" | "undo" | "not-measured";

interface Verdict {
	id: string;
	route: string;
	expected: string;
	observed: Observed;
	verdict: "match" | "mismatch" | "withheld";
	reason?: string;
}

const verdicts: Verdict[] = [];

function record(v: Verdict): void {
	verdicts.push(v);
}

/** A reason is REQUIRED — "not measured" with no cause is the shape that reads as a pass. */
function withhold(entry: ControlEntry, reason: string): void {
	record({ id: entry.id, route: entry.route, expected: String(entry.status), observed: "not-measured", verdict: "withheld", reason });
}

// ── never press a confirm ───────────────────────────────────────────────────────────────────────

/**
 * Wrap a locator so that clicking it fails loudly. The destructive button is located so it can be
 * ASSERTED — its presence and its label are the evidence — and this makes "never pressed" a
 * property of the code rather than a promise in a comment.
 */
function assertNeverPressed(confirmButton: Locator, id: string): Locator {
	return new Proxy(confirmButton, {
		get(target, prop, receiver) {
			if (prop === "click" || prop === "dblclick" || prop === "press") {
				return () => {
					throw new Error(`${id}: this spec must NEVER activate a destructive confirmation. Only Cancel is ever pressed.`);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

// ── observation 1: the request deny-list ────────────────────────────────────────────────────────

interface RequestWatch {
	stop: () => Request[];
}

/**
 * Record every non-GET request the page issues from now on. A Next server action posts to the
 * CURRENT url carrying a `Next-Action` header, so the mutation has no distinctive path of its own —
 * the method and the header are what identify it.
 */
function watchMutations(page: Page): RequestWatch {
	const seen: Request[] = [];
	const onRequest = (req: Request) => {
		const method = req.method();
		if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
		// Next's RSC and telemetry chatter is not a mutation.
		const url = req.url();
		if (/\/_next\/(static|image)\//.test(url)) return;
		seen.push(req);
	};
	page.on("request", onRequest);
	return {
		stop: () => {
			page.off("request", onRequest);
			return seen;
		},
	};
}

function describeRequests(reqs: Request[]): string {
	return reqs.map((r) => `${r.method()} ${new URL(r.url()).pathname}${r.headers()["next-action"] ? " [Next-Action]" : ""}`).join(", ");
}

// ── observation 2: the database fingerprint ─────────────────────────────────────────────────────

/**
 * Row counts across every public table.
 *
 * Table-agnostic on purpose: the registry does not record which table a control writes, and adding
 * that field would be a second list to keep in step by hand. Counting everything asks a broader
 * question — "did this click destroy ANY row" — which is the question the spec actually wants, and
 * it cannot go stale when a control starts writing somewhere new.
 */
async function fingerprint(): Promise<Map<string, number>> {
	const sql = db();
	const tables = await sql<{ table_name: string }[]>`
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		ORDER BY table_name`;
	const counts = new Map<string, number>();
	for (const { table_name } of tables) {
		// `sql.unsafe` is generic, so the row shape is DECLARED rather than cast. CLAUDE.md §6 bans
		// `as`, and the ban earns its keep here: the cast this replaced claimed `{ n: number }` of a
		// value the driver types as `Row & Iterable<Row>`, which is exactly the assertion a reader
		// cannot check and the compiler had already refused.
		const rows = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public."${table_name}"`);
		counts.set(table_name, rows[0].n);
	}
	return counts;
}

function diffFingerprints(before: Map<string, number>, after: Map<string, number>): string[] {
	const moved: string[] = [];
	for (const [table, n] of before) {
		const m = after.get(table);
		if (m !== undefined && m !== n) moved.push(`${table} ${n}→${m}`);
	}
	return moved;
}

// ── reaching a control ──────────────────────────────────────────────────────────────────────────

/**
 * Walk the entry's `reach` chain. Returns null with a reason when a step cannot be taken — a
 * control behind an opener that is not rendered is NOT MEASURED, not absent.
 */
async function walkReach(page: Page, entry: ControlEntry): Promise<string | null> {
	for (const step of entry.reach ?? []) {
		const [kind, nameRaw] = Object.entries(step)[0] ?? [];
		if (!kind || !nameRaw) continue;
		const name = String(nameRaw);
		try {
			if (kind === "section") {
				// A `section` is the LABELLED REGION holding the control, and in this console that
				// label is often not a heading. `SettingsDangerRow` (settings-ui.tsx:193) renders
				// its `title` as `<div className="… font-medium …">` with no role at all, so a
				// heading-only lookup withheld `org.delete` and `project.delete` — both of which
				// need no fixture and were the two controls this suite could otherwise have
				// measured on a bare org. Measured on run 34364283140: 0 of 46.
				//
				// So: heading first, because that is the correct markup and the one the console is
				// moving toward (CLAUDE.md §6 / SectionHeading); plain text second, because that is
				// what is there today. Falling back is not papering over the a11y gap — the gap is
				// reported separately — it is refusing to let this suite's denominator depend on it.
				const heading = page.getByRole("heading", { name: new RegExp(escapeRe(name), "i") }).first();
				const label = page.getByText(new RegExp(`^\\s*${escapeRe(name)}\\s*$`, "i")).first();
				const target = (await heading.count()) > 0 ? heading : label;
				await target.waitFor({ state: "visible", timeout: 8_000 });
				await target.scrollIntoViewIfNeeded();
				continue;
			}
			// menu / open / select all resolve to "activate the thing named, then wait for it".
			const opener = page
				.getByRole("button", { name: new RegExp(escapeRe(name), "i") })
				.or(page.getByLabel(new RegExp(escapeRe(name), "i")))
				.first();
			await opener.waitFor({ state: "visible", timeout: 8_000 });
			await opener.click();
			await page.waitForTimeout(300);
		} catch {
			return `reach step {${kind}: "${name}"} could not be taken on ${entry.route}`;
		}
	}
	return null;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The roles the registry is allowed to name.
 *
 * The ledger is DATA — a YAML file a person edits — so its `role` arrives as an unconstrained
 * string, and `getByRole` takes a union. Narrowing against this list rather than casting is what
 * turns a typo into a recorded finding: an unknown role withholds the control WITH its reason,
 * where a cast would have thrown mid-test or, worse, silently matched nothing.
 *
 * It holds exactly what the ledger uses today (`button`, `menuitem`, `switch`) plus the roles a
 * destructive trigger could plausibly take next. Extend it when a control needs one; the failure
 * when you have not is legible.
 */
const CONTROL_ROLES = ["button", "menuitem", "switch", "link", "tab", "option", "checkbox", "radio", "menuitemcheckbox"] as const;

type ControlRole = (typeof CONTROL_ROLES)[number];

function asControlRole(role: string | undefined): ControlRole | null {
	return CONTROL_ROLES.find((r): r is ControlRole => r === role) ?? null;
}

/** The trigger, by accessible role + name — never a CSS class, per the field contract. */
function triggerFor(page: Page, entry: ControlEntry): { locator: Locator } | { problem: string } {
	const role = asControlRole(entry.control?.role);
	const name = entry.control?.name;
	if (!entry.control?.role || !name) return { problem: "the entry declares no `control` role+name, so there is nothing to activate" };
	if (!role) {
		return {
			problem: `the entry names role "${entry.control.role}", which is not one of ${CONTROL_ROLES.join(", ")}. Either the role is a typo or a destructive control has taken a new shape — add it to CONTROL_ROLES.`,
		};
	}
	// A name carrying a `<placeholder>` is a template; match its literal prefix.
	const literal = name.split("<")[0].trim();
	const matcher = literal ? new RegExp(escapeRe(literal), "i") : new RegExp(escapeRe(name), "i");
	return { locator: page.getByRole(role, { name: matcher }).first() };
}

// ── the suite ───────────────────────────────────────────────────────────────────────────────────

let ctx: AuditContext;

test.beforeAll(async ({ browser }) => {
	const page = await browser.newPage();
	const orgSlug = await resolveOrgSlug(page);
	ctx = { orgSlug, owner: await resolveOwner(orgSlug) };
	await seedRouteFixtures(ctx);
	saveContext(ctx);
	await page.close();
});

test.beforeEach(async () => {
	restoreContext(ctx);
});

for (const entry of CONTROLS) {
	test(`${entry.id} — declares ${entry.confirm ?? "none"} (${entry.status})`, async ({ page }) => {
		const routeRecord = consoleRoutes().routes.find((r) => r.route === entry.route);
		if (!routeRecord) {
			withhold(entry, `the manifest has no route ${entry.route} — the control's page moved or was removed`);
			return;
		}

		let url: string;
		try {
			url = materialize(routeRecord, ctx);
		} catch (err) {
			withhold(entry, `route could not be materialised: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		await page.goto(url, { waitUntil: "domcontentloaded" });

		const reachFailure = await walkReach(page, entry);
		if (reachFailure) {
			withhold(entry, reachFailure);
			return;
		}

		const resolved_trigger = triggerFor(page, entry);
		if ("problem" in resolved_trigger) {
			withhold(entry, resolved_trigger.problem);
			return;
		}
		const trigger = resolved_trigger.locator;
		const matches = await trigger.count();
		if (matches === 0 || !(await trigger.isVisible().catch(() => false))) {
			withhold(entry, `the trigger {${entry.control?.role}: "${entry.control?.name}"} is not rendered at ${url} for this persona`);
			return;
		}
		// AMBIGUITY IS A FINDING, NOT A COIN FLIP.
		//
		// `.first()` would pick one of N identically-named controls and record the verdict against
		// whichever it happened to be — a true assertion about the wrong control, which is worse
		// than no assertion because it reads as measured. The settings pages make this concrete:
		// `SettingsDangerRow` names every destructive button just "Delete" and puts the thing being
		// deleted in an unassociated `<div>`, so two danger rows on one page are two identical
		// buttons.
		//
		// After `reach` has run, more than one match means the entry's reach did not narrow to a
		// single control — that is a defect in the registry entry, or in the product's naming, and
		// either way it must be reported rather than guessed past.
		if (matches > 1) {
			withhold(
				entry,
				`the trigger {${entry.control?.role}: "${entry.control?.name}"} matches ${matches} controls at ${url} after its reach chain — ` +
					"ambiguous, so no verdict can be attributed. Narrow the entry's `reach`, or give the control an accessible name that distinguishes it.",
			);
			return;
		}

		// ── both observations start BEFORE the click.
		const before = await fingerprint();
		const watch = watchMutations(page);

		await trigger.click();
		await page.waitForTimeout(500);

		const dialog = page.locator('[data-slot="alert-dialog-content"], [role="alertdialog"], [role="dialog"]').first();
		const dialogAppeared = await dialog.isVisible().catch(() => false);

		const expectsDialog = entry.confirm === "alert-dialog" || entry.confirm === "confirm-dialog";
		let observed: Observed;

		if (expectsDialog) {
			if (!dialogAppeared) {
				const requests = watch.stop();
				record({ id: entry.id, route: entry.route, expected: String(entry.status), observed: "missing", verdict: "mismatch", reason: "no confirmation appeared" });
				expect(dialogAppeared, `${entry.id}: the registry says this control confirms with a ${entry.confirm}, and no dialog appeared. Requests seen: ${describeRequests(requests) || "none"}`).toBe(true);
				return;
			}
			// The destructive button is ASSERTED, never activated.
			if (entry.confirm_action) {
				const confirmButton = assertNeverPressed(dialog.getByRole("button", { name: new RegExp(escapeRe(entry.confirm_action), "i") }).first(), entry.id);
				await expect(confirmButton, `${entry.id}: the dialog should offer "${entry.confirm_action}"`).toBeVisible();
			}
			if (entry.dialog_title) {
				const literal = entry.dialog_title.split("<")[0].trim();
				if (literal) {
					await expect(dialog, `${entry.id}: a renamed dialog is a finding, not a pass — expected a title beginning "${literal}"`).toContainText(new RegExp(escapeRe(literal), "i"));
				}
			}
			// The ONLY button this file ever presses.
			const cancel = dialog.getByRole("button", { name: /^(cancel|no|keep|nevermind|never mind)\b/i }).first();
			await expect(cancel, `${entry.id}: a confirmation with no way out is worse than none`).toBeVisible();
			await cancel.click();
			await expect(dialog, `${entry.id}: Cancel should close the dialog`).toBeHidden({ timeout: 5_000 });
			observed = "confirmed";
		} else if (entry.confirm === "undo") {
			observed = "undo";
		} else {
			// `none` / `popover`: the registry records that a bare click fires. The spec asserts the
			// RECORDED state — a dialog appearing here is stale evidence, and the lane that added it
			// must flip the entry in the same PR. It is a finding either way, never a silent pass.
			//
			// It is asserted WITHOUT clicking: the trigger was already activated above, and for a
			// `none` control that click is the mutation. That is why the two observations below are
			// read but not required to be empty for this branch — see the verdict.
			observed = dialogAppeared ? "confirmed" : entry.status === "inert" ? "inert" : "missing";
		}

		const requests = watch.stop();
		const after = await fingerprint();
		const moved = diffFingerprints(before, after);

		if (expectsDialog) {
			// Nothing may have travelled, and nothing may have moved.
			const mutating = requests.filter((r) => r.method() !== "GET");
			expect(mutating.length, `${entry.id}: a request went out while the confirmation was open and Cancel was pressed — the mutation fired before the user agreed. ${describeRequests(mutating)}`).toBe(0);
			expect(moved, `${entry.id}: Cancel was pressed and rows still moved: ${moved.join(", ")}`).toEqual([]);
		}

		record({
			id: entry.id,
			route: entry.route,
			expected: String(entry.status),
			observed,
			verdict: observed === entry.status ? "match" : "mismatch",
			reason: observed === entry.status ? undefined : `the registry records "${entry.status}" and the run observed "${observed}"`,
		});

		expect(
			observed,
			`${entry.id}: the registry records "${entry.status}" but the run observed "${observed}". ` +
				(observed === "confirmed"
					? "A confirmation now exists where the ledger says there is none — the lane that added it must flip this entry in the same PR (the registry header states this)."
					: "The confirmation the ledger promises is not there."),
		).toBe(entry.status);
	});
}

// ── the report, and the guard on its own emptiness ──────────────────────────────────────────────

test.afterAll(async () => {
	const dir = path.resolve(__dirname, "..", "..", "test-results");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const measured = verdicts.filter((v) => v.verdict !== "withheld").length;
	writeFileSync(
		path.join(dir, "destructive.json"),
		`${JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				ledgerCount: CONTROLS.length,
				measured,
				withheld: verdicts.length - measured,
				controls: verdicts,
			},
			null,
			2,
		)}\n`,
	);
	await closeDb();
});

test("the run measured something — a withheld verdict is not a pass", async () => {
	const measured = verdicts.filter((v) => v.verdict !== "withheld").length;
	const withheld = verdicts.filter((v) => v.verdict === "withheld");
	const summary = withheld.map((v) => `  · ${v.id}: ${v.reason}`).join("\n");
	// Printed on every run, pass or fail: this number is what the next reader raises MIN_MEASURED to.
	console.log(`destructive: ${measured} of ${CONTROLS.length} controls measured, ${withheld.length} withheld.\n${summary}`);
	expect(
		measured,
		`only ${measured} of ${CONTROLS.length} controls were actually driven. A suite whose fixtures all stopped seeding reports green while asserting nothing, so this floor exists to make that loud.\n${summary}`,
	).toBeGreaterThanOrEqual(MIN_MEASURED);
});
