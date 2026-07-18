// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Recurring PostHog error → GitHub issue filer (see .github/workflows/posthog-error-issues.yml).
//
// PostHog can't natively open GitHub issues (its GitHub integration is manual; alerts only hit
// Slack/webhook), so this queries the error-tracking issues API, keeps the ones that recur above a
// threshold, and files ONE deduped GitHub issue each into a triage queue (label `from:posthog`) — to
// be picked up and worked (e.g. in a Claude session) when someone is around. Idempotent: dedup is by a
// hidden marker in the issue body (`posthog-issue:<id>`), matched via GitHub search, so re-runs update
// rather than duplicate. Fixed label set only (bug / from:posthog) — no per-issue labels (avoids sprawl).
//
// Pure Node (global fetch, Node 20+); no deps. Auth: PostHog personal API key + GITHUB_TOKEN.
// Run `--dry-run` to print what it WOULD file (and the raw shape of the first issue) without writing.

const HOST = (process.env.POSTHOG_HOST || "https://eu.posthog.com").replace(/\/+$/, "");
const PROJECT_ID = process.env.POSTHOG_PROJECT_ID || "";
const PH_KEY = process.env.POSTHOG_PERSONAL_API_KEY || "";
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || ""; // owner/name
const MIN_OCCURRENCES = Number(process.env.PH_MIN_OCCURRENCES || "5");
const LOOKBACK_DAYS = Number(process.env.PH_LOOKBACK_DAYS || "7");
const MAX_ISSUES = Number(process.env.PH_MAX_ISSUES || "20"); // cap issues filed per run (anti-spam)
const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

const LABELS = ["bug", "from:posthog"];

/** Fail with a clear message + non-zero exit. */
function die(msg) {
	console.error(`posthog-error-issues: ${msg}`);
	process.exit(1);
}

/** A hidden, greppable marker that ties a GitHub issue back to its PostHog issue (dedup key). */
function marker(id) {
	return `posthog-issue:${id}`;
}

/** The PostHog dashboard URL for an issue (best-effort; the console link users click). */
function posthogIssueUrl(id) {
	return `${HOST}/project/${PROJECT_ID}/error_tracking/${id}`;
}

/** Reads the first present numeric field from a list of candidate paths on an object (defensive: the
 *  error-tracking API's count field names vary by version — occurrences/volume/aggregations.*). */
function firstNumber(obj, keys) {
	for (const k of keys) {
		const parts = k.split(".");
		let v = obj;
		for (const p of parts) v = v == null ? undefined : v[p];
		if (typeof v === "number") return v;
	}
	return undefined;
}

/** GET all pages of the PostHog error-tracking issues list (Bearer personal key). */
async function fetchPostHogIssues() {
	const since = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
	let url = `${HOST}/api/environments/${PROJECT_ID}/error_tracking/issues/?status=active&date_from=${encodeURIComponent(since)}&limit=100`;
	const out = [];
	for (let guard = 0; url && guard < 50; guard++) {
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${PH_KEY}`, Accept: "application/json" },
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			die(`PostHog issues fetch ${res.status}: ${text.slice(0, 400)}`);
		}
		const page = await res.json();
		for (const r of page.results || []) out.push(r);
		url = page.next || "";
	}
	return out;
}

/** Occurrences for an issue, trying the field names PostHog has used across versions. */
function occurrencesOf(issue) {
	return (
		firstNumber(issue, [
			"occurrences",
			"aggregations.occurrences",
			"volume",
			"aggregations.volume",
			"count",
		]) ?? 0
	);
}

/** Build the GitHub issue title + body for a PostHog issue. */
function renderIssue(issue) {
	const id = issue.id;
	const name = issue.name || issue.title || "Untitled error";
	const description = issue.description || issue.message || "";
	const occ = occurrencesOf(issue);
	const sessions = firstNumber(issue, ["sessions", "aggregations.sessions"]);
	const users = firstNumber(issue, ["users", "aggregations.users"]);
	const firstSeen = issue.first_seen || issue.firstSeen || "";
	const lastSeen = issue.last_seen || issue.lastSeen || "";
	const title = `[error] ${name}`.slice(0, 240);
	const body = [
		`**PostHog error issue** — auto-filed because it recurs (${occ} occurrences in the last ${LOOKBACK_DAYS}d).`,
		"",
		`- **Error:** ${name}`,
		description ? `- **Message:** ${String(description).slice(0, 500)}` : "",
		`- **Occurrences:** ${occ}${sessions != null ? ` · sessions: ${sessions}` : ""}${users != null ? ` · users: ${users}` : ""}`,
		firstSeen ? `- **First seen:** ${firstSeen}` : "",
		lastSeen ? `- **Last seen:** ${lastSeen}` : "",
		`- **PostHog:** ${posthogIssueUrl(id)}`,
		"",
		"### How to work this",
		"Open the PostHog link for the stack trace + session replay, find the root cause in the codebase,",
		"and open a PR into `dev`. (Good candidate to hand to a Claude session.)",
		"",
		`<!-- ${marker(id)} -->`,
	]
		.filter(Boolean)
		.join("\n");
	return { title, body };
}

/** GitHub REST helper (Bearer GITHUB_TOKEN). */
async function gh(path, init = {}) {
	const res = await fetch(`https://api.github.com${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${GH_TOKEN}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		die(`GitHub ${init.method || "GET"} ${path} → ${res.status}: ${text.slice(0, 400)}`);
	}
	return res.status === 204 ? null : res.json();
}

/** Find an existing (open or closed) GitHub issue for a PostHog issue id, via the body marker. */
async function findExistingIssue(id) {
	const q = encodeURIComponent(`repo:${REPO} in:body "${marker(id)}" type:issue`);
	const r = await gh(`/search/issues?q=${q}&per_page=1`);
	return r.items && r.items[0] ? r.items[0] : null;
}

async function main() {
	if (!PROJECT_ID || !PH_KEY) die("POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY are required.");
	if (!DRY_RUN && (!GH_TOKEN || !REPO)) die("GITHUB_TOKEN and GITHUB_REPOSITORY are required (unless --dry-run).");

	const issues = await fetchPostHogIssues();
	console.log(`Fetched ${issues.length} active PostHog issue(s) (lookback ${LOOKBACK_DAYS}d).`);
	if (DRY_RUN && issues[0]) {
		// Surface the raw shape once so the count/field mapping can be confirmed against the live API.
		console.log("Raw shape of first issue:\n", JSON.stringify(issues[0], null, 2).slice(0, 1500));
	}

	const recurring = issues
		.filter((i) => occurrencesOf(i) >= MIN_OCCURRENCES)
		.sort((a, b) => occurrencesOf(b) - occurrencesOf(a))
		.slice(0, MAX_ISSUES);
	console.log(`${recurring.length} issue(s) at/above ${MIN_OCCURRENCES} occurrences (cap ${MAX_ISSUES}).`);
	if (recurring.length < issues.filter((i) => occurrencesOf(i) >= MIN_OCCURRENCES).length) {
		console.log(`Note: capped at ${MAX_ISSUES}; some qualifying issues were skipped this run.`);
	}

	let created = 0;
	let updated = 0;
	for (const issue of recurring) {
		const { title, body } = renderIssue(issue);
		if (DRY_RUN) {
			console.log(`\n--- would file (posthog id ${issue.id}) ---\n${title}\n${body}`);
			continue;
		}
		const existing = await findExistingIssue(issue.id);
		if (existing) {
			// Refresh the recurrence count without duplicating; nudge closed ones by commenting only.
			await gh(`/repos/${REPO}/issues/${existing.number}/comments`, {
				method: "POST",
				body: JSON.stringify({
					body: `Still recurring — now ${occurrencesOf(issue)} occurrences (last ${LOOKBACK_DAYS}d). ${posthogIssueUrl(issue.id)}`,
				}),
			});
			updated++;
			console.log(`updated #${existing.number} (posthog ${issue.id})`);
		} else {
			const res = await gh(`/repos/${REPO}/issues`, {
				method: "POST",
				body: JSON.stringify({ title, body, labels: LABELS }),
			});
			created++;
			console.log(`created #${res.number} (posthog ${issue.id})`);
		}
	}
	console.log(`\nDone. created=${created} updated=${updated} dry_run=${DRY_RUN}`);
}

main().catch((e) => die(e instanceof Error ? e.stack || e.message : String(e)));
