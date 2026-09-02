// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every marketplace add-on's default values must RENDER against its pinned chart.
//
// This exists because #2058 shipped and nothing caught it. Loki's catalog entry set
// `deploymentMode: SingleBinary` together with non-zero `read`/`write`/`backend` replicas — two
// values that are each perfectly valid and jointly rejected by the chart's own `validate.yaml`.
// `helm template` exited non-zero, ArgoCD had no target state to compare against and reported
// `sync=Unknown`, and Loki could not install on any cloud, for any customer.
//
// Nothing in this repo could have seen it. Type-checking passes: the values are well-typed. Unit
// tests pass: they assert what the resolver emits, not what the chart accepts. The offer-parity and
// config-carriage guards both pass: neither measures add-on values. The only thing that knows the
// combination is illegal is the chart, and until this script nothing ever asked it. A comment in
// tests/lib/addons/addon-secrets.test.ts says the chart shapes were "verified against the pinned
// charts via `helm template`" — by hand, once, at the time.
//
// So the check is: for each entry, hand `helm template` the pinned chart + the catalog's own
// defaults and require an exit code of zero. It fetches real charts, which is why it lives in its
// own CI job with helm on PATH rather than inside the console's vitest run.
//
// It renders the DEFAULTS only. `toValues(config)` output is not covered, because that needs a
// user config to be meaningful — worth adding once there is a fixture per add-on, and worth saying
// plainly that a value only reachable through `toValues` is still unguarded today.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
// Any ONE per-cloud fixture is enough here: the fixtures differ only in external-dns's `provider`
// knob, and what this check reads — each add-on's chart repo, name and pinned version — is identical
// across clouds. hetzner because it is the harness's own default cloud, so this file agrees with
// addonCatalogFixture() and with the three scripts/addons/ checks on which fixture "the" fixture is.
const CATALOG = join(ROOT, "test", "e2e", "fixtures", "addon_catalog.hetzner.json");
// The Hetzner in-cluster data services are NOT marketplace add-ons — they are synthesized per
// component by hetznerDataServicesToAddOns — so nothing here ever rendered them, even though they
// are the charts most likely to break: the mapper hand-translates a value schema per chart, and
// hetzner-services.ts records that both the cache and the queue chart had ALREADY shipped broken
// once (a deleted Bitnami chart version, and a 404 default image). The same generated fixture the
// Go harness seeds is rendered here (#2397).
const HETZNER = join(ROOT, "test", "e2e", "fixtures", "hetzner_data_services.json");
// Shared with scripts/ci/tofu-test-retry-fetch.sh — see loadFetchPatterns().
const FETCH_PATTERNS = join(ROOT, "scripts", "ci", "chart-fetch-network-errors.txt");
// The known-outage ledger — see loadOutages(). Its own header carries the reasoning.
const OUTAGES = join(ROOT, "scripts", "ci", "chart-repo-outages.txt");

/** Fail loudly with a reason, never a silent skip — a renderer that renders nothing proves nothing. */
function die(msg) {
	console.error(`✗ addon chart render: ${msg}`);
	process.exit(1);
}

/** Is helm on PATH? Its absence must be an error here, not a pass. */
function requireHelm() {
	try {
		execFileSync("helm", ["version", "--short"], { stdio: "pipe" });
	} catch {
		die("`helm` is not on PATH. This check renders real charts; without helm it would pass by doing nothing, which is the failure mode it exists to prevent.");
	}
}

/**
 * The shared "we could not reach a chart repository" classifier.
 *
 * SHARED WITH scripts/ci/tofu-test-retry-fetch.sh, deliberately, because that job asks the same
 * question about the same class of failure and two copies of a classifier drift silently: the copy
 * nobody updated keeps retrying a failure the other has learned is real. The file's own header
 * carries the reasoning, including the two shapes kept deliberately OUT of it.
 *
 * AN EMPTY OR MISSING LIST IS FATAL, not permissive. An empty alternation compiles to a regex that
 * matches every string, so losing the file would turn "retry only a fetch failure" into "retry
 * everything" — the worst available answer, and the one that looks like it is working.
 */
export function loadFetchPatterns(file = FETCH_PATTERNS) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		throw new Error(`cannot read the fetch classifier at ${file}. Without it this check cannot tell a chart repo it could not reach from a chart that does not render, and guessing either way is worse than stopping.`);
	}
	const patterns = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("#"));
	if (patterns.length === 0) throw new Error(`${file} yielded no patterns. An empty alternation matches every string, so every render failure would be retried and then reported as somebody else's outage.`);
	return new RegExp(patterns.join("|"), "i");
}

/**
 * The known-outage ledger: `Map<repoUrl, {issue, reason}>`.
 *
 * A MISSING FILE IS AN EMPTY LEDGER, and that is the safe direction here — the opposite of
 * loadFetchPatterns() above, deliberately. Losing the classifier turns "retry only a fetch failure"
 * into "retry everything", so its absence must be fatal. Losing this file excuses NOTHING, so its
 * absence is simply the strictest possible reading: every unreachable repo reds the probe. An empty
 * ledger is also the normal state — an outage is the exception, not the baseline.
 *
 * A line that is not blank, not a comment and does not parse IS fatal. A ledger that quietly drops
 * the entry it could not read is a ledger that excuses nothing while reporting that it did.
 */
export function loadOutages(file = OUTAGES) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return new Map();
	}
	const out = new Map();
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "" || line.startsWith("#")) continue;
		const m = /^(\S+)\s+(#\d+)\s+(\S.*)$/.exec(line);
		if (!m) {
			throw new Error(`${file}:${i + 1} does not parse. Expected \`<repo-url>  #<issue>  <reason>\`, got: ${line}`);
		}
		if (out.has(m[1])) throw new Error(`${file}:${i + 1} lists ${m[1]} twice. One entry per repository, so deleting it is one edit.`);
		out.set(m[1], { issue: m[2], reason: m[3] });
	}
	return out;
}

let _outages;
/** The ledger, loaded once. A malformed ledger stops the run rather than half-applying. */
function outages() {
	if (!_outages) {
		try {
			_outages = loadOutages();
		} catch (e) {
			die(e.message);
		}
	}
	return _outages;
}

let _fetchRe;
/** The classifier, loaded once. A failure to load is fatal here, never a permissive default. */
function fetchRe() {
	if (!_fetchRe) {
		try {
			_fetchRe = loadFetchPatterns();
		} catch (e) {
			die(e.message);
		}
	}
	return _fetchRe;
}

/** How long one render gets. Every CI runner is a cold cache, so this covers a fetch AND a render. */
const RENDER_TIMEOUT_MS = Number(process.env.ADDON_RENDER_TIMEOUT_MS ?? 180_000);

/**
 * One `helm template`. Returns null on success, else the first six lines of stderr.
 *
 * A TIMEOUT IS NOT A RENDER FAILURE, AND IT ARRIVES WITH NOTHING TO SAY. `execFileSync` kills the
 * child with SIGTERM and hands back `code: "ETIMEDOUT"` and an EMPTY stderr — so before this, a
 * timed-out render was reported under "charts that do not render with the values this repo emits"
 * with a blank error body underneath it. Nothing to read, nothing to act on, and the wrong
 * diagnosis: it names the values, which are not implicated at all.
 *
 * It is not hypothetical. Rendering the catalog on a COLD helm cache — which is every CI runner —
 * timed kyverno@3.2.6 out at 180s and reported exactly that, while `helm template` with the same
 * arguments against a warm cache exits 0 in seconds. The chart is fine; the fetch was slow.
 *
 * So a timeout is returned as a synthesized, fetch-shaped message: it says what happened, and the
 * classifier above will retry it rather than blaming the values.
 */
function renderOnce(addon, dir) {
	const valuesPath = join(dir, `${addon.label ?? addon.id}.yaml`.replace(/[^a-zA-Z0-9._-]/g, "_"));
	writeFileSync(valuesPath, JSON.stringify(addon.values ?? {}));
	try {
		execFileSync(
			"helm",
			[
				"template",
				addon.id,
				addon.chart,
				"--repo",
				addon.chartRepo,
				"--version",
				addon.version,
				"--namespace",
				addon.namespace,
				"-f",
				valuesPath,
			],
			// STDOUT IS DISCARDED, and that is a fix rather than a tidy-up. This check reads the EXIT
			// CODE and nothing else, but `stdio: "pipe"` made node buffer the whole rendered manifest
			// set against `spawnSync`'s 1 MB default `maxBuffer`. Kyverno renders past that, so the
			// call failed with `spawnSync helm ENOBUFS` — and was reported under "charts that do not
			// render with the values this repo emits", which is the wrong diagnosis about the wrong
			// component. Measured on kyverno@3.2.6 with helm 3.19.0; the CI pin (3.16.2) renders less
			// and stayed under the limit, so this was a landmine waiting on either a helm bump or a
			// chart that grew. Ignoring stdout removes the ceiling instead of raising it.
			{ stdio: ["ignore", "ignore", "pipe"], timeout: RENDER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
		);
		return null;
	} catch (err) {
		if (err.code === "ETIMEDOUT" || err.signal === "SIGTERM") {
			return `helm template timed out after ${Math.round(RENDER_TIMEOUT_MS / 1000)}s: Client.Timeout exceeded while fetching ${addon.chartRepo}. The process was killed, so it produced no output of its own — this line is synthesized.`;
		}
		const stderr = String(err.stderr ?? "").trim() || String(err.message ?? "").trim();
		// An empty error body is unreadable and, worse, unfalsifiable — it looks like a values
		// failure with no evidence. Never emit one.
		return (stderr || `helm exited ${err.status ?? "non-zero"} with no output at all — nothing here names a cause, which is itself the finding.`).split("\n").slice(0, 6).join("\n");
	}
}

/** Block the thread. Node has no sync sleep, and this loop is deliberately serial. */
function sleepSync(seconds) {
	if (seconds <= 0) return;
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/**
 * Render one spec, retrying ONLY a failure that means "we could not reach the repository".
 *
 * WHY THIS IS NOT A BLANKET RETRY. A retry that re-rolls a genuine render failure is a gate that has
 * stopped gating, and this gate exists because #2058 shipped a Loki values combination the chart
 * itself rejects. So a failure that is not fetch-shaped is returned on the FIRST attempt, and the
 * two kinds are reported separately — the entire complaint in #2754 is that they were
 * indistinguishable in the check status, which trains everyone to re-run this job without reading
 * it, including the day it goes red for a real reason.
 *
 * Returns null on success, else `{kind: "render" | "fetch", stderr, attempts}`.
 */
export function render(addon, dir, opts = {}) {
	const attempts = opts.attempts ?? Number(process.env.ADDON_RENDER_FETCH_ATTEMPTS ?? 3);
	const base = opts.sleepBase ?? Number(process.env.ADDON_RENDER_FETCH_SLEEP_BASE ?? 10);
	const isFetch = opts.isFetch ?? fetchRe();
	const once = opts.renderOnce ?? renderOnce;
	for (let attempt = 1; ; attempt++) {
		const stderr = once(addon, dir);
		if (stderr === null) return null;
		if (!isFetch.test(stderr)) return { kind: "render", stderr, attempts: attempt };
		if (attempt >= attempts) return { kind: "fetch", stderr, attempts: attempt };
		const host = /https?:\/\/[a-zA-Z0-9._-]+/.exec(stderr)?.[0] ?? "a chart repository";
		console.warn(`::warning title=chart fetch flake (#2754)::${addon.label ?? addon.id}: attempt ${attempt}/${attempts} could not reach ${host} — a live third-party fetch, not a chart that fails to render. Retrying in ${attempt * base}s.`);
		sleepSync(attempt * base);
	}
}

/**
 * Fetch ONE repository's index and nothing else. Returns null on success, else stderr.
 *
 * `helm repo add` is the smallest thing helm does that performs exactly this fetch, and — the
 * reason to prefer it over a bare `fetch()` — it fails with the SAME wording the shared classifier
 * already knows, through the same Go HTTP client, the same redirect handling and the same TLS
 * stack that `helm template` uses. A hand-rolled probe would answer a slightly different question
 * and disagree with the render pass on exactly the days it matters.
 *
 * Everything is written into a throwaway `--repository-config` / `--repository-cache`, so this
 * never touches the runner's real helm state and the fixed name is free to be reused.
 */
function probeOnce(repo, dir) {
	try {
		execFileSync(
			"helm",
			["repo", "add", "probe", repo, "--force-update", "--repository-config", join(dir, "repositories.yaml"), "--repository-cache", join(dir, "cache")],
			{ stdio: ["ignore", "ignore", "pipe"], timeout: RENDER_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
		);
		return null;
	} catch (err) {
		if (err.code === "ETIMEDOUT" || err.signal === "SIGTERM") {
			return `helm repo add timed out after ${Math.round(RENDER_TIMEOUT_MS / 1000)}s: Client.Timeout exceeded while fetching ${repo}. The process was killed, so it produced no output of its own — this line is synthesized.`;
		}
		const stderr = String(err.stderr ?? "").trim() || String(err.message ?? "").trim();
		return (stderr || `helm exited ${err.status ?? "non-zero"} with no output at all — nothing here names a cause, which is itself the finding.`).split("\n").slice(0, 6).join("\n");
	}
}

/**
 * Probe every distinct repository the catalog ships and score it against the outage ledger.
 *
 * WHY IT IS ITS OWN PASS, AND ITS OWN CI STEP (#3961). "we could not reach the repo" and "the chart
 * does not render" are different diagnoses with different owners, and until this they shared one
 * exit code. Splitting the probe out gives each its own step name and its own outcome, so the
 * checks list answers the question without anybody opening a log.
 *
 * THE REPO SET IS DERIVED from the same two generated fixtures the render pass reads, never typed:
 * a hand-written list of what a guard watches stops covering silently, and the first thing it stops
 * covering is whatever was added last.
 *
 * FOUR VERDICTS, BOTH DIRECTIONS — the third is the one that keeps the ledger honest:
 *
 *   unreachable + ledgered    a known outage. Reported loudly; not fatal.
 *   unreachable + unledgered  FATAL. A new outage is a human decision, never an automatic pass.
 *   REACHABLE   + ledgered    FATAL. The outage is over; delete the entry.
 *   ledgered, not in catalog  FATAL. A dead entry excusing a repo nobody ships.
 *
 * And a NON-TRANSPORT failure is never excusable: if helm reached the host and the host answered
 * that this is not a chart repository, the repo has MOVED, which is exactly the case that needs the
 * catalog changed. The ledger covers a third party being down, not a third party having relocated.
 *
 * @returns {boolean} true if the probe passes.
 */
function reachability(specs) {
	const ledger = outages();
	const repos = new Map();
	for (const s of specs) {
		if (!repos.has(s.chartRepo)) repos.set(s.chartRepo, []);
		repos.get(s.chartRepo).push(s.label);
	}
	if (repos.size === 0) die("no chart repositories to probe — a reachability check over nothing reports success and means nothing.");

	const dir = mkdtempSync(join(tmpdir(), "addon-reach-"));
	const known = [];
	const newlyDown = [];
	const moved = [];
	const recovered = [];
	try {
		for (const [repo, ids] of repos) {
			const err = render({ id: repo, label: repo, chartRepo: repo }, dir, { renderOnce: () => probeOnce(repo, dir) });
			const entry = ledger.get(repo);
			if (err === null) {
				process.stdout.write(`  · ${repo}\n`);
				if (entry) recovered.push({ repo, ids, entry });
				continue;
			}
			// helm answered, and answered that this is not a chart repository. That is a MOVE.
			if (err.kind === "render") {
				process.stdout.write(`  ✗ ${repo}\n`);
				moved.push({ repo, ids, err: err.stderr });
				continue;
			}
			process.stdout.write(`  ${entry ? "~" : "?"} ${repo}\n`);
			(entry ? known : newlyDown).push({ repo, ids, err: err.stderr, attempts: err.attempts, entry });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	// A ledger entry for a repository the catalog no longer ships. Its OWN bucket, because the
	// `moved` message below says "the host answered, and did not answer with a chart index" — and
	// that is a claim about a probe this URL never got. A guard that reports the wrong cause is the
	// defect this whole file is about; it does not get to make it in its own reporting.
	const dead = [...ledger.keys()].filter((url) => !repos.has(url));

	// Reported even when it is the only thing that happened, because "two charts were not checked
	// this run" is a fact about this run's coverage and must never be inferable only from silence.
	// On stdout for the same reason as the render pass's block below — it shares a stream with the
	// `✓` line it qualifies, so the two cannot arrive out of order.
	if (known.length > 0) {
		console.log(`\n~ ${known.length} of ${repos.size} chart repositor(ies) are DOWN and recorded as known outages — the charts behind them are NOT CHECKED this run:\n`);
		for (const k of known) {
			console.log(`  ${k.repo}  ${k.entry.issue}  (${k.ids.join(", ")})  after ${k.attempts} attempt(s)`);
			console.log(`      ${k.entry.reason}`);
			for (const line of k.err.split("\n")) console.log(`      ${line}`);
			console.log("");
		}
		console.log(
			`::warning title=known chart-repo outage (#3961)::${known.length} chart repositor(ies) are unreachable and recorded in scripts/ci/chart-repo-outages.txt, so ${known.reduce((n, k) => n + k.ids.length, 0)} chart(s) were not rendered this run. This is somebody else's uptime, not this PR. The entry is deleted — and this check goes RED until it is — the moment the host answers again.`,
		);
	}

	if (newlyDown.length > 0) {
		console.error(`\n? ${newlyDown.length} of ${repos.size} chart repositor(ies) are unreachable and NOT recorded:\n`);
		for (const f of newlyDown) {
			console.error(`  ${f.repo}  (${f.ids.join(", ")})  after ${f.attempts} attempt(s)`);
			for (const line of f.err.split("\n")) console.error(`      ${line}`);
			console.error("");
		}
		console.error(
			"::error title=chart repo unreachable (#3961)::A chart repository this repo ships is down and nobody has looked at it yet.\n" +
				"Establish the canonical URL from the project's OWN documentation before touching the catalog — an\n" +
				"unreachable host is not evidence that the URL moved, and a guess ships to every user and is still\n" +
				"wrong after the host comes back. If the URL is right and the host is simply down, record it in\n" +
				"scripts/ci/chart-repo-outages.txt with the issue number and this step goes green until it recovers.",
		);
	}

	if (recovered.length > 0) {
		console.error(`\n✗ ${recovered.length} recorded outage(s) are OVER — the repository answers again:\n`);
		for (const r of recovered) console.error(`  ${r.repo}  ${r.entry.issue}  (${r.ids.join(", ")})`);
		console.error(
			"\n::error title=stale outage entry (#3961)::Delete these lines from scripts/ci/chart-repo-outages.txt.\n" +
				"An excuse that outlives the thing it excused is how a chart stops being checked for good, so the\n" +
				"ledger is enforced in BOTH directions: it goes red when an entry stops being true, not when\n" +
				"somebody remembers to look.",
		);
	}

	if (moved.length > 0) {
		console.error(`\n✗ ${moved.length} repositor(ies) answered, and did not answer with a chart index:\n`);
		for (const m of moved) {
			console.error(`  ${m.repo}  (${m.ids.join(", ")})`);
			for (const line of m.err.split("\n").filter(Boolean)) console.error(`      ${line}`);
		}
		console.error(
			"\n::error title=chart repo moved (#3961)::This is NOT excusable by the outage ledger, whatever is written in it.\n" +
				"A host that answers and says this is not a chart repository has MOVED — which is the one case where\n" +
				"the catalog genuinely has to change. Find the new URL in the project's own documentation.",
		);
	}

	if (dead.length > 0) {
		console.error(`\n✗ ${dead.length} recorded outage(s) name a repository the catalog does not ship:\n`);
		for (const url of dead) console.error(`  ${url}  ${ledger.get(url).issue}`);
		console.error(
			"\n::error title=dead outage entry (#3961)::Delete these lines from scripts/ci/chart-repo-outages.txt.\n" +
				"Nothing probes them, so they can never recover and can never be retired by the check above — an\n" +
				"entry in that state is an excuse with no expiry, which is the one thing this ledger must not hold.",
		);
	}

	if (newlyDown.length > 0 || recovered.length > 0 || moved.length > 0 || dead.length > 0) return false;

	console.log(
		known.length > 0
			? `\n✓ ${repos.size - known.length} of ${repos.size} chart repositor(ies) reachable; ${known.length} down and recorded as a known outage.`
			: `\n✓ all ${repos.size} chart repositor(ies) reachable, and the outage ledger is empty.`,
	);
	return true;
}

if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);

requireHelm();

let catalog;
try {
	catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
} catch {
	die(`could not read the generated catalog at ${CATALOG}. Run \`pnpm -C apps/console run export:addon-catalog\`.`);
}
if (!Array.isArray(catalog) || catalog.length === 0) {
	die("the generated catalog is empty — a render check over nothing reports success and means nothing.");
}

// The Hetzner specs carry REAL values (sizes, storage classes, replica counts) rather than a
// catalog default, so unlike the marketplace half this genuinely covers the resolver's output — the
// gap the header comment names as still unguarded.
let hetzner;
try {
	const fx = JSON.parse(readFileSync(HETZNER, "utf8"));
	// `chartedNotOffered` is where Harbor lives: #2397 wired its values but the `registry` kind is
	// still refused at deploy, so it is not part of the seeded max-config surface. It is exactly the
	// mapping that most needs asking, being the newest, so it is rendered here all the same.
	hetzner = [...fx.addons, ...(fx.chartedNotOffered ?? [])];
} catch {
	die(`could not read the generated Hetzner specs at ${HETZNER}. Run \`pnpm -C apps/console run export:hetzner-data-services\`.`);
}
if (!Array.isArray(hetzner) || hetzner.length === 0) {
	die("the generated Hetzner in-cluster spec list is empty — a render check over nothing reports success and means nothing.");
}

const specs = [
	...catalog.map((a) => ({ ...a, label: a.id })),
	...hetzner.map((a) => ({ ...a, label: `hetzner:${a.id}` })),
];

// `--reachability` is the SEPARATE half (#3961): it asks only "can we reach these hosts", so its CI
// step carries only that answer. It exits here rather than falling through — a step that reports two
// verdicts under one name is the shape this split exists to remove.
if (process.argv.includes("--reachability")) process.exit(reachability(specs) ? 0 : 1);

const ledger = outages();
const dir = mkdtempSync(join(tmpdir(), "addon-render-"));
const failures = [];
const unreachable = [];
const outaged = [];
try {
	for (const addon of specs) {
		const err = render(addon, dir);
		// THREE buckets, not two. A fetch failure against a repository already established as down
		// and recorded in the ledger is the outage being reported a second time under a name that
		// says "render" — which is the misdirection this whole check is trying not to produce. It is
		// still printed, and still counted as a chart this run did not check; it just does not red a
		// step called `Every add-on renders`. A fetch failure against any OTHER repo stays fatal:
		// that one is unexplained, and an unexplained fetch failure is exactly what a flake looks
		// like the first time it is real.
		const bucket = err === null ? null : err.kind !== "fetch" ? failures : ledger.has(addon.chartRepo) ? outaged : unreachable;
		process.stdout.write(err === null ? `  · ${addon.label}\n` : `  ${bucket === failures ? "✗" : bucket === outaged ? "~" : "?"} ${addon.label}\n`);
		if (err) bucket.push({ id: addon.label, chart: `${addon.chart}@${addon.version}`, repo: addon.chartRepo, err: err.stderr, attempts: err.attempts, entry: ledger.get(addon.chartRepo) });
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}

// A run that rendered NOTHING must not pass, however well-documented the reason. The ledger exists
// to stop one third party's downtime reddening a check about our values; it is not a route to a
// green check that measured nothing, which is the failure mode every other guard in this repo is
// written against.
if (outaged.length === specs.length) {
	die(`every one of the ${specs.length} spec(s) failed to fetch against a repository recorded in scripts/ci/chart-repo-outages.txt. Not one chart was rendered, so this run checked nothing — and a check that measures nothing must never report success, whatever the ledger says.`);
}

// ON STDOUT, NOT STDERR, and that is not a style choice. The per-spec lines and the final `✓` are
// stdout; putting this block on stderr interleaved it in the live run — the first CI run of this
// change printed the "2 chart(s) were NOT CHECKED" header, then the `✓` line, THEN the two chart
// names, so the success line landed in the middle of the caveat qualifying it. This block is the one
// place a reader learns what this run did not measure, so it shares a stream with the claim it
// qualifies. The failure blocks below stay on stderr: nothing follows them but an exit.
if (outaged.length > 0) {
	console.log(`\n~ ${outaged.length} of ${specs.length} chart(s) were NOT CHECKED — their repository is a recorded outage:\n`);
	for (const f of outaged) console.log(`  ${f.id}  (${f.chart})  ${f.repo}  ${f.entry.issue}`);
	console.log(
		`\n::warning title=charts not checked (#3961)::${outaged.length} chart(s) were not rendered because their repository is recorded as down in scripts/ci/chart-repo-outages.txt. This run says nothing about their values. The reachability step owns that outage and goes red the moment the host answers again.`,
	);
}

// REPORTED SEPARATELY, AND FIRST. The two are different diagnoses with different owners: one is a
// values/chart defect this PR can fix, the other is a third party being down. Printing them in one
// list is exactly the complaint in #2754 — "indistinguishable in the check status" — and it is what
// trains a reader to re-run the job without opening it.
if (unreachable.length > 0) {
	console.error(`\n? ${unreachable.length} of ${specs.length} chart(s) could not be FETCHED — the render never happened, so this says nothing about the values:\n`);
	for (const f of unreachable) {
		console.error(`  ${f.id}  (${f.chart})  after ${f.attempts} attempt(s)`);
		for (const line of f.err.split("\n")) console.error(`      ${line}`);
		console.error("");
	}
	// COUNT THE REPOSITORIES, NOT THE CHARTS. This line used to say "N chart repositor(ies)" while N
	// was `unreachable.length`, which counts SPECS — and two of the specs sit on one repo, so a
	// single broken host reported itself as "2 chart repositor(ies) unreachable". #3961 was opened
	// and worked partly on the strength of hunting a second broken upstream that never existed.
	const hosts = new Set(unreachable.map((f) => f.repo));
	console.error(
		`::error title=chart fetch failed (#2754)::${unreachable.length} chart(s) across ${hosts.size} repositor(ies) were unreachable after ${process.env.ADDON_RENDER_FETCH_ATTEMPTS ?? 3} attempts: ${[...hosts].join(", ")}\n` +
			"This is a FETCH failure, not a render failure. The catalog spans many independent third-party\n" +
			"hosts and every one of them is somebody else's uptime; nothing in this PR can affect it.\n" +
			"It still fails rather than passing, because a chart this run never rendered is a chart this\n" +
			"run did not check — but re-running it is a reasonable response here, and reading the values is not.\n" +
			"If it is down for good rather than flaking, the `Chart repositories are reachable` step owns\n" +
			"that decision: record it in scripts/ci/chart-repo-outages.txt with an issue number.",
	);
}

if (failures.length > 0) {
	console.error(`\n✗ ${failures.length} of ${specs.length} chart(s) do not render with the values this repo emits:\n`);
	for (const f of failures) {
		console.error(`  ${f.id}  (${f.chart})`);
		for (const line of f.err.split("\n")) console.error(`      ${line}`);
		console.error("");
	}
	console.error(
		"A chart that does not render produces NO manifest, so ArgoCD reports `sync=Unknown` rather than\n" +
			"OutOfSync and the add-on silently never installs. Fix the values against the chart, not the check.",
	);
}

if (failures.length > 0 || unreachable.length > 0) process.exit(1);

console.log(
	`\n✓ ${specs.length - outaged.length} of ${specs.length} charts render (${catalog.length} marketplace add-ons with their defaults, ` +
		`${hetzner.length} Hetzner in-cluster specs with their RESOLVED values)` +
		`${outaged.length > 0 ? `, with ${outaged.length} NOT CHECKED behind a recorded outage` : ""}.`,
);

/**
 * Assertions over the classifier and the retry, with `helm` stubbed out.
 *
 * WHY IT EXISTS. The retry added in #2754 is the dangerous kind of change: if it is too eager it
 * re-rolls a genuine render failure and this gate quietly stops gating — and the gate exists because
 * a values combination the chart itself rejects shipped to production once already. So the negative
 * cases come first, and the attempt COUNT is asserted rather than only the outcome: a function that
 * gives up after one attempt returns the same shape as one that tried three times.
 */
function selfTest() {
	let pass = 0;
	let fail = 0;
	const ok = (label, cond, detail = "") => {
		if (cond) {
			console.log(`ok   - ${label}`);
			pass++;
		} else {
			console.log(`FAIL - ${label}${detail ? `: ${detail}` : ""}`);
			fail++;
		}
	};

	const re = loadFetchPatterns();
	ok("the shared classifier loads from scripts/ci/", re instanceof RegExp);
	ok("helm's unreachable-repository message is a fetch failure", re.test('Error: looks like "https://grafana.github.io/helm-charts" is not a valid chart repository or cannot be reached: Get "…/index.yaml": dial tcp: network is unreachable'));
	ok("a TCP reset is a fetch failure", re.test("read tcp 10.1.0.4:52134->1.2.3.4:443: connection reset by peer"));
	// The negatives are the whole point: each of these is a REAL failure that must not be re-rolled.
	ok("a chart rejecting our values is NOT a fetch failure", !re.test("Error: execution error at (loki/templates/validate.yaml:24:6): You have more than zero replicas configured for SingleBinary mode"));
	ok("a missing chart version is NOT a fetch failure", !re.test('Error: chart "harbor" version "1.99.0" not found in https://helm.goharbor.io repository'));
	ok("an OpenTofu plugin crash is NOT a fetch failure", !re.test("Error: Plugin did not respond ... unexpected EOF"), "the shape deliberately kept out of the shared list");
	ok("a 404 is NOT a fetch failure — that chart is genuinely not there", !re.test("failed to fetch https://charts.example.com/foo-1.0.0.tgz : 404 Not Found"));

	// An empty list must REFUSE. Losing the patterns would otherwise mean "retry everything".
	const tmp = mkdtempSync(join(tmpdir(), "addon-render-selftest-"));
	try {
		const empty = join(tmp, "empty.txt");
		writeFileSync(empty, "# only a comment\n\n");
		let threw = false;
		try {
			loadFetchPatterns(empty);
		} catch (e) {
			threw = /yielded no patterns/.test(e.message);
		}
		ok("a classifier with no patterns refuses rather than matching everything", threw);
		let threwMissing = false;
		try {
			loadFetchPatterns(join(tmp, "nope.txt"));
		} catch (e) {
			threwMissing = /cannot read the fetch classifier/.test(e.message);
		}
		ok("a missing classifier refuses too", threwMissing);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}

	// The retry, with the renderer stubbed. `calls` is closed over rather than counted from output,
	// so the assertion sees attempts the reporting never prints.
	const spec = { id: "loki", label: "loki", chart: "loki", chartRepo: "https://grafana.github.io/helm-charts", version: "6.0.0", namespace: "obs" };
	const RENDER_ERR = "Error: execution error at (loki/templates/validate.yaml:24:6): You have more than zero replicas configured for SingleBinary mode";
	const FETCH_ERR = 'Error: looks like "https://grafana.github.io/helm-charts" is not a valid chart repository or cannot be reached: connection reset by peer';
	const drive = (script) => {
		let calls = 0;
		const r = render(spec, "/tmp", { attempts: 3, sleepBase: 0, isFetch: re, renderOnce: () => script[Math.min(calls++, script.length - 1)] });
		return { r, calls };
	};

	let { r, calls } = drive([RENDER_ERR]);
	ok("a chart that does not render is NOT retried", calls === 1, `${calls} call(s)`);
	ok("...and is reported as a render failure", r?.kind === "render", JSON.stringify(r));

	({ r, calls } = drive([FETCH_ERR]));
	ok("an unreachable repository is retried to the ceiling", calls === 3, `${calls} call(s)`);
	ok("...and is reported as a fetch failure, not a render one", r?.kind === "fetch", JSON.stringify(r));

	({ r, calls } = drive([FETCH_ERR, null]));
	ok("a fetch flake that clears is a pass", r === null && calls === 2, `${calls} call(s), ${JSON.stringify(r)}`);

	({ r, calls } = drive([FETCH_ERR, RENDER_ERR]));
	ok("a real failure behind a flake still fails, on the attempt that found it", r?.kind === "render" && calls === 2, `${calls} call(s), ${JSON.stringify(r)}`);

	({ r, calls } = drive([null]));
	ok("a chart that renders runs once", r === null && calls === 1, `${calls} call(s)`);

	// The case that produced this fix. A timeout kills helm with SIGTERM and an EMPTY stderr, so
	// before #2754 it was reported as "does not render with the values this repo emits" with a blank
	// body — the wrong diagnosis, with nothing under it to argue with. Measured: rendering the
	// catalog on a cold helm cache timed kyverno@3.2.6 out at 180s while the same `helm template`
	// against a warm cache exits 0 in seconds.
	const TIMEOUT_ERR = "helm template timed out after 180s: Client.Timeout exceeded while fetching https://kyverno.github.io/kyverno/. The process was killed, so it produced no output of its own — this line is synthesized.";
	ok("a timed-out render classifies as a FETCH failure, not a values failure", re.test(TIMEOUT_ERR));
	({ r, calls } = drive([TIMEOUT_ERR, null]));
	ok("...so it is retried, and a slow fetch that then succeeds is a pass", r === null && calls === 2, `${calls} call(s)`);
	ok("...and the synthesized line says the output was synthesized", /synthesized/.test(TIMEOUT_ERR));

	// ── THE OUTAGE LEDGER (#3961) ──────────────────────────────────────────────────────────────
	//
	// This file is an EXCUSE, so its self-test is written against the ways an excuse goes wrong:
	// it excuses more than it was given, it excuses the wrong CLASS of failure, or it keeps
	// excusing after the thing it excused is over. The committed ledger is read too, because a
	// parser that only ever sees fixtures is a parser that has not met the real file.
	const led = mkdtempSync(join(tmpdir(), "addon-render-outages-"));
	try {
		const write = (body) => {
			const p = join(led, `l-${Math.random().toString(36).slice(2)}.txt`);
			writeFileSync(p, body);
			return p;
		};
		const parsed = loadOutages(write("# a comment\n\nhttps://a.example  #12  because\n"));
		ok("a well-formed ledger line parses", parsed.size === 1 && parsed.get("https://a.example")?.issue === "#12");
		ok("...and carries its reason, which is the part a human reads", parsed.get("https://a.example")?.reason === "because");

		const throws = (file, re) => {
			try {
				loadOutages(file);
				return false;
			} catch (e) {
				return re.test(e.message);
			}
		};
		ok("a line with no issue number is REFUSED", throws(write("https://a.example  because\n"), /does not parse/), "an undated excuse is one nobody can retire");
		ok("a line with no reason is REFUSED", throws(write("https://a.example  #12\n"), /does not parse/));
		ok("the same repository twice is REFUSED", throws(write("https://a.example  #1  x\nhttps://a.example  #2  y\n"), /twice/));
		ok("a MISSING ledger is empty, not fatal — absence must excuse nothing", loadOutages(join(led, "nope.txt")).size === 0);
		ok("a ledger of only comments is empty", loadOutages(write("# nothing here\n")).size === 0);

		// The committed file itself. It is the one input this check cannot fixture away.
		const realLedger = loadOutages();
		ok("the committed ledger parses", realLedger instanceof Map);
		for (const [url, e] of realLedger) {
			ok(`  ledger entry ${url} names an issue and a reason`, /^#\d+$/.test(e.issue) && e.reason.length > 20, JSON.stringify(e));
		}

		// THE CLASS RULE, which is what stops the ledger becoming a way to ignore a moved repo. The
		// bucketing in the render pass keys on `kind`, so this asserts the classifier's verdict on
		// the two shapes that decide it — not the bucketing's own opinion of itself.
		ok("a host that answers 'not a chart repository' over a live connection is still a FETCH shape", re.test(FETCH_ERR));
		ok("...but a chart version missing from a reachable index is NOT, so no ledger entry can excuse it", !re.test('Error: chart "cloudnative-pg" version "0.22.1" not found in https://cloudnative-pg.github.io/charts repository'));

		// The probe reuses render()'s retry, so an outage is retried to the ceiling before it is
		// believed — a ledger entry written against one bad packet would be worse than no ledger.
		const probeSpec = { id: "https://a.example", label: "https://a.example", chartRepo: "https://a.example" };
		let pc = 0;
		const pr = render(probeSpec, led, { attempts: 3, sleepBase: 0, isFetch: re, renderOnce: () => (pc++, FETCH_ERR) });
		ok("the reachability probe retries an unreachable repo to the ceiling", pc === 3 && pr?.kind === "fetch", `${pc} call(s)`);
		pc = 0;
		const pm = render(probeSpec, led, { attempts: 3, sleepBase: 0, isFetch: re, renderOnce: () => (pc++, 'Error: chart "x" version "1" not found in https://a.example repository') });
		ok("...and does not retry a host that answered, which is a MOVE and never excusable", pc === 1 && pm?.kind === "render", `${pc} call(s)`);
	} finally {
		rmSync(led, { recursive: true, force: true });
	}

	console.log(fail === 0 ? `\naddon-charts-render self-test: all ${pass} passed` : `\naddon-charts-render self-test: ${fail} of ${pass + fail} FAILED`);
	return fail === 0;
}
