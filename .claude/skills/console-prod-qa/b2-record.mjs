#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The B2 evidence record of a `/console-prod-qa golden-path <cloud>` run: built, checked, and
// self-tested by ONE writer, so the record the skill commits is the record the programme rollup reads.
//
//   node .claude/skills/console-prod-qa/b2-record.mjs --self-test
//   node .claude/skills/console-prod-qa/b2-record.mjs write --run-id qa-20261214-1032 --cloud hetzner \
//        --build-sha <40 hex> --verdict pass --fresh-account true \
//        --steps sign-up,connect,design,deploy,running-cluster,destroy --observer maintainer \
//        --body <scratchpad file>
//   node .claude/skills/console-prod-qa/b2-record.mjs check [file ...]
//
// Why a script and not a template in SKILL.md: the rollup's front-matter reader understands a small
// YAML subset and refuses everything else (`parseFrontMatter` in scripts/programme-rollup.mjs), and
// the schema refuses a pass that misses one of six steps. A record typed by hand at the end of a
// one-hour production run is exactly where a quoting slip lands — and the rollup reports it as an
// integrity failure on somebody else's PR, long after the cluster it describes is gone.
//
// Nothing here is a copy. The clouds and the step vocabulary come from docs/beta/evidence-schema.json,
// the reader, the validator, the evidence directories and the B2 evaluation come from
// scripts/programme-rollup.mjs. The self-test feeds the records this file builds through the rollup's
// own `deriveBeta` and asserts they are ACCEPTED — the acceptance test of REL-L13 (#6914).
//
// What this file adds on top of the schema, each stricter than it, never looser:
//   · `instrument` is this skill, `observer` is stated, and `evidence` names the record's own path.
//   · `date` is the run id's minute and the file name is that same minute: one run, one file.
//   · `steps` are the completed steps, in golden-path order, with no gap — `destroy` without `deploy`
//     is a typing error, not an observation.
//   · `freshAccount: false` can never pass (the schema says so too), and `verdict: pass` needs all six.
//   · The body may not contain an email address. The repository is public; the identity is recorded
//     as SHA-256 digests only (SKILL.md §0).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SKILL = ".claude/skills/console-prod-qa/SKILL.md";
const SCHEMA_PATH = "docs/beta/evidence-schema.json";
const B2_DIR = "apps/console/docs/qa/prod-runs";

const rollup = await import(path.join(ROOT, "scripts/programme-rollup.mjs"));
const { parseFrontMatter, validateAgainstSchema, EVIDENCE_DIRS, deriveBeta } = rollup;

/** Read the evidence schema from the tree (never a copy). */
function readSchema() {
	return JSON.parse(fs.readFileSync(path.join(ROOT, SCHEMA_PATH), "utf8"));
}

/** The four beta clouds, as the schema's cloud enum names them (minus `all`). */
function cloudsOf(schema) {
	return schema.properties.cloud.enum.filter((c) => c !== "all");
}

/** The six golden-path steps, in the order the schema lists them — which is the order they happen. */
function stepsOf(schema) {
	return schema.properties.steps.items.enum;
}

/** `qa-20261214-1032` → `{date: "2026-12-14T10:32:00Z", file: "2026-12-14-1032.md"}`, or null. */
export function parseRunId(runId) {
	const m = /^qa-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(runId ?? "");
	if (m === null) return null;
	const [, y, mo, d, h, mi] = m;
	const date = `${y}-${mo}-${d}T${h}:${mi}:00Z`;
	if (Number.isNaN(Date.parse(date)) || new Date(date).toISOString() !== `${y}-${mo}-${d}T${h}:${mi}:00.000Z`) return null;
	return { date, file: `${y}-${mo}-${d}-${h}${mi}.md` };
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SPDX = "<!--\nSPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>\nSPDX-License-Identifier: AGPL-3.0-only\n-->\n";

/**
 * The checks this skill adds on top of the schema. Returns what is wrong, empty when nothing is.
 *
 * @param {Record<string, unknown>} data the parsed front matter
 * @param {string} file the record's repository path
 * @param {string} text the whole file
 * @param {Record<string, any>} schema
 */
export function skillRules(data, file, text, schema) {
	const errors = [];
	const order = stepsOf(schema);
	const name = /^(\d{4})-(\d{2})-(\d{2})-(\d{4})\.md$/.exec(path.basename(file));
	const run = name === null ? null : parseRunId(`qa-${name[1]}${name[2]}${name[3]}-${name[4]}`);
	if (data.predicate !== "B2" || data.aspect !== undefined) errors.push("this skill writes plain B2 records only (no `aspect`; REL-L18 writes the managed-runner ones)");
	if (data.instrument !== SKILL) errors.push(`\`instrument\` must be \`${SKILL}\``);
	if (!["agent", "maintainer"].includes(String(data.observer))) errors.push("`observer` must be `agent` or `maintainer`");
	if (!Array.isArray(data.evidence) || !data.evidence.includes(file)) errors.push(`\`evidence\` must name the record itself (\`${file}\`)`);
	if (run === null) errors.push(`the file name must be the run id's minute, \`<YYYY-MM-DD>-<HHMM>.md\` (got \`${path.basename(file)}\`)`);
	else if (data.date !== run.date) errors.push(`\`date\` must be the run id's minute (${run.date}), the same minute as the file name`);
	if (Array.isArray(data.steps)) {
		const want = order.slice(0, data.steps.length);
		if (JSON.stringify(data.steps) !== JSON.stringify(want)) errors.push(`\`steps\` must be the completed steps in golden-path order with no gap (${order.join(", ")}); got ${data.steps.join(", ")}`);
	}
	if (data.verdict === "pass" && data.freshAccount !== true) errors.push("a pass needs `freshAccount: true`");
	// The SPDX header's legal@ address is the only one allowed, and only as this writer's exact header.
	if (EMAIL.test(text.startsWith(SPDX) ? text.slice(SPDX.length) : text)) errors.push("the record contains an email address — the identity goes in as SHA-256 digests only");
	return errors;
}

/**
 * Build one record, or say why not. Pure: nothing is written.
 *
 * @param {{runId: string, cloud: string, buildSha: string, verdict: string, freshAccount: string,
 *          steps: string, observer: string, body: string}} o
 * @param {Record<string, any>} schema
 * @returns {{file: string, text: string, errors: string[]}}
 */
export function buildRecord(o, schema) {
	const run = parseRunId(o.runId);
	if (run === null) return { file: "", text: "", errors: [`--run-id must be \`qa-<yyyymmdd>-<hhmm>\` in UTC (got \`${o.runId}\`)`] };
	const file = `${B2_DIR}/${run.file}`;
	const steps = (o.steps ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
	const errors = [];
	if (!cloudsOf(schema).includes(o.cloud)) errors.push(`--cloud must be one of ${cloudsOf(schema).join(", ")} (got \`${o.cloud}\`)`);
	if (!["true", "false"].includes(o.freshAccount)) errors.push("--fresh-account must be `true` or `false`");
	for (const s of steps) if (!/^[a-z-]+$/.test(s)) errors.push(`--steps: \`${s}\` is not a step slug`);
	const body = (o.body ?? "").replace(/^\s+/, "");
	if (body.startsWith("---") || body.startsWith("<!--")) errors.push("--body is the prose only; this script writes the SPDX header and the front matter");
	if (!body.startsWith("# ")) errors.push("--body must start with its `# ` title");
	if (errors.length > 0) return { file, text: "", errors };
	// Quoted where a YAML reader could retype the value (docs/beta/README.md: "Quote `date` and `buildSha`").
	const fm = [
		"---",
		"schemaVersion: 1",
		"predicate: B2",
		`cloud: ${o.cloud}`,
		`date: "${run.date}"`,
		`buildSha: "${o.buildSha}"`,
		`verdict: ${o.verdict}`,
		`instrument: ${SKILL}`,
		`observer: ${o.observer}`,
		`freshAccount: ${o.freshAccount}`,
		`steps: [${steps.join(", ")}]`,
		"evidence:",
		`  - ${file}`,
		"---",
	].join("\n");
	const text = `${SPDX}\n${fm}\n\n${body.replace(/\s*$/, "")}\n`;
	return { file, text, errors: checkRecord(file, text, schema) };
}

/**
 * Everything the rollup checks of a record in the B2 directory, plus this skill's rules.
 * A file with no front matter is a pre-format QA report, not a record: `null` means "not a record".
 *
 * @returns {string[] | null}
 */
export function checkRecord(file, text, schema) {
	const fm = parseFrontMatter(text);
	if (!fm.found) return null;
	if ("error" in fm) return [fm.error];
	const errors = validateAgainstSchema(fm.data, schema).map((e) => `schema: ${e}`);
	const home = EVIDENCE_DIRS.find((d) => file.startsWith(`${d.dir}/`));
	if (home === undefined || home.dir !== B2_DIR) errors.push(`a B2 record lives in \`${B2_DIR}/\` (docs/beta/README.md)`);
	return [...errors, ...skillRules(fm.data, file, text, schema)];
}

/** Parse `--flag value` pairs. */
function flags(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const m = /^--([a-z-]+)$/.exec(argv[i]);
		if (m === null) throw new Error(`unexpected argument \`${argv[i]}\``);
		out[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
	}
	return out;
}

/** `write`: build the record, refuse on any error, refuse to overwrite, then write it. */
function cmdWrite(argv) {
	const schema = readSchema();
	const f = flags(argv);
	if (f.body === undefined || !fs.existsSync(f.body)) throw new Error("--body <file> is required: the prose of the run, written in the scratchpad first");
	const r = buildRecord({ ...f, body: fs.readFileSync(f.body, "utf8") }, schema);
	if (r.errors.length > 0) {
		for (const e of r.errors) console.error(`b2-record: ${e}`);
		console.error("b2-record: nothing written.");
		process.exit(1);
	}
	const target = path.join(ROOT, r.file);
	if (fs.existsSync(target)) {
		console.error(`b2-record: ${r.file} already exists. A record is never edited; one run is one file. Nothing written.`);
		process.exit(1);
	}
	fs.writeFileSync(target, r.text);
	console.log(`b2-record: wrote ${r.file}`);
}

/** `check`: validate the named records (default: every Markdown file in the B2 directory). */
function cmdCheck(files) {
	const schema = readSchema();
	const list = files.length > 0
		? files.map((f) => path.relative(ROOT, path.resolve(f)))
		: fs.readdirSync(path.join(ROOT, B2_DIR)).filter((n) => n.endsWith(".md") && n !== "README.md").sort().map((n) => `${B2_DIR}/${n}`);
	let bad = 0;
	let records = 0;
	for (const file of list) {
		const errors = checkRecord(file, fs.readFileSync(path.join(ROOT, file), "utf8"), schema);
		if (errors === null) continue;
		records++;
		for (const e of errors) console.error(`b2-record: ${file}: ${e}`);
		if (errors.length > 0) bad++;
	}
	console.log(`b2-record: ${records} record(s) checked, ${bad} refused (${list.length - records} file(s) without front matter are reports, not records)`);
	process.exit(bad > 0 ? 1 : 0);
}

/** `--self-test`: the writer's records validate, the rollup accepts them, and each refusal fires. */
function selfTest() {
	const schema = readSchema();
	const clouds = cloudsOf(schema);
	const all = stepsOf(schema);
	let failed = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`  ok   ${name}`);
		else {
			failed++;
			console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
		}
	};
	const sha = "703d40d946914ab0dafdb4ed643a2c2437fa7def";
	const body = (cloud) => `# B2 golden path — ${cloud}\n\n1. Signed up as sha256 \`${"a".repeat(64)}\`.\n`;
	const opts = (over = {}) => ({ runId: "qa-20261214-1032", cloud: "hetzner", buildSha: sha, verdict: "pass", freshAccount: "true", steps: all.join(","), observer: "maintainer", body: body("hetzner"), ...over });

	ok("the schema still lists four clouds", clouds.length === 4, clouds.join());
	ok("the schema still lists six steps, sign-up first and destroy last", all.length === 6 && all[0] === "sign-up" && all[5] === "destroy", all.join());
	ok("the B2 directory is still the rollup's B2 home", EVIDENCE_DIRS.some((d) => d.dir === B2_DIR && d.predicate === "B2" && d.aspect === null));
	const skillText = fs.readFileSync(path.join(ROOT, SKILL), "utf8");
	ok("SKILL.md names every step the schema lists", all.every((s) => skillText.includes(`\`${s}\``)), all.filter((s) => !skillText.includes(`\`${s}\``)).join());
	ok("SKILL.md keeps disable-model-invocation: true", /^disable-model-invocation: true$/m.test(skillText));

	// One pass record per cloud, each one from a different run minute.
	const passes = clouds.map((cloud, i) => buildRecord(opts({ cloud, runId: `qa-2026121${4 + i}-1032`, body: body(cloud) }), schema));
	for (const [i, r] of passes.entries()) ok(`a ${clouds[i]} pass builds clean`, r.errors.length === 0, r.errors.join("; "));
	ok("the file name is the run id's minute", passes[0].file === `${B2_DIR}/2026-12-14-1032.md`, passes[0].file);
	ok("an SPDX comment precedes the front matter", passes[0].text.startsWith("<!--\nSPDX-FileCopyrightText"));

	// The acceptance test: the rollup's own evaluator reads all four and files none of them as a failure.
	const fixture = (records, at = "2026-12-20T00:00:00Z") =>
		deriveBeta({
			spine: { clouds, offered_clouds: clouds },
			schema,
			tsCatalogText: `export const AVAILABLE_CLOUDS: readonly CloudSlug[] = [${clouds.map((c) => `"${c}"`).join(", ")}];`,
			records,
			bundles: [],
			paidMarketsText: "export const PAID_MARKETS: readonly PaidMarketCell[] = [];",
			launchText: "export const PAID_LAUNCH_ANNOUNCED_FOR: string | null = null;",
			legalSet: { documents: [{ id: "terms", sealed: true, version: "2026-08-24", contentHash: "ab" }] },
			reaper: [],
			at,
		});
	const accepted = fixture(passes.map((r) => ({ file: r.file, text: r.text })));
	const b2 = accepted.predicates.find((p) => p.id === "B2");
	const recordFailures = accepted.failures.filter((f) => f.includes(B2_DIR));
	ok("deriveBeta reads all four records", accepted.recordCount === 4, String(accepted.recordCount));
	ok("deriveBeta files none of them as a failure", recordFailures.length === 0, recordFailures.join("; "));
	// `unmeasured` with "passed inside the window" is the best a record can do today: the rollup does
	// not ask git whether `buildSha` is on `main` (the snapshot carries no history). Anything else —
	// `unmet`, or a different reason — means the record was not read as a pass.
	for (const cloud of clouds) {
		const cell = b2.cells[cloud];
		ok(`deriveBeta reads the ${cloud} record as a pass inside the window`, cell.state === "unmeasured" && /passed inside the window/.test(cell.why), `${cell.state}: ${cell.why}`);
	}
	const tooOld = fixture([passes[0]].map((r) => ({ file: r.file, text: r.text })), "2027-02-20T00:00:00Z");
	ok("deriveBeta still applies the 31-day window to it", tooOld.predicates.find((p) => p.id === "B2").cells[clouds[0]].state === "unmet", tooOld.predicates.find((p) => p.id === "B2").cells[clouds[0]].why);

	// A fail stops at the step that failed, and the rollup reads it as the newest word.
	const failRec = buildRecord(opts({ runId: "qa-20261215-0900", cloud: clouds[0], verdict: "fail", steps: all.slice(0, 3).join(","), body: body(clouds[0]) }), schema);
	ok("a fail with the first three steps builds clean", failRec.errors.length === 0, failRec.errors.join("; "));
	const newerFail = fixture([passes[0], failRec].map((r) => ({ file: r.file, text: r.text })));
	ok("a newer fail outranks an older pass in deriveBeta", newerFail.predicates.find((p) => p.id === "B2").cells[clouds[0]].state === "unmet");

	// Each refusal fires.
	const refuses = (name, o, pattern) => {
		const r = buildRecord(opts(o), schema);
		ok(`refused: ${name}`, r.errors.some((e) => pattern.test(e)), r.errors.join("; ") || "(no error)");
	};
	refuses("a pass missing a step", { steps: all.slice(0, 5).join(",") }, /destroy|steps/);
	refuses("a pass from an account that was not fresh", { freshAccount: "false" }, /freshAccount/);
	refuses("steps out of order", { verdict: "fail", steps: "sign-up,design" }, /no gap/);
	refuses("a step outside the vocabulary", { verdict: "fail", steps: "sign-up,checkout" }, /steps/);
	refuses("cloud `all`", { cloud: "all" }, /--cloud/);
	refuses("a fifth cloud", { cloud: "alibaba" }, /--cloud/);
	refuses("a short build SHA", { buildSha: "703d40d9" }, /buildSha/);
	refuses("an unknown verdict", { verdict: "partial" }, /verdict/);
	refuses("an observer outside agent/maintainer", { observer: "cohort" }, /observer/);
	refuses("a run id that is not qa-<yyyymmdd>-<hhmm>", { runId: "qa-2026-12-14" }, /--run-id/);
	refuses("an impossible run minute", { runId: "qa-20261314-1032" }, /--run-id/);
	refuses("an email address in the body", { body: "# B2\n\nSigned up as qa+x@example.com.\n" }, /email address/);
	refuses("a body that brings its own front matter", { body: "---\nverdict: pass\n---\n# B2\n" }, /prose only/);

	// `check` refuses a hand-edited record the writer would not have produced.
	const edited = passes[0].text.replace(`date: "2026-12-14T10:32:00Z"`, `date: "2026-12-14T11:00:00Z"`);
	ok("check: a date that is not the file name's minute is refused", (checkRecord(passes[0].file, edited, schema) ?? []).some((e) => /run id's minute/.test(e)));
	ok("check: a record outside the B2 directory is refused", (checkRecord("docs/beta/evidence/b3/2026-12-14-1032.md", passes[0].text, schema) ?? []).length > 0);
	ok("check: a pre-format report with no front matter is not a record", checkRecord(`${B2_DIR}/2026-11-16-1417.md`, "<!-- x -->\n# Production QA run\n", schema) === null);

	if (failed > 0) {
		console.log(`b2-record self-test: ${failed} FAILED`);
		process.exit(1);
	}
	console.log("b2-record self-test: all checks passed");
}

const [cmd, ...rest] = process.argv.slice(2);
try {
	if (cmd === "--self-test") selfTest();
	else if (cmd === "write") cmdWrite(rest);
	else if (cmd === "check") cmdCheck(rest);
	else {
		console.error("usage: b2-record.mjs --self-test | write --run-id … --cloud … --build-sha … --verdict … --fresh-account … --steps … --observer … --body <file> | check [file …]");
		process.exit(2);
	}
} catch (e) {
	console.error(`b2-record: ${e.message}`);
	process.exit(2);
}
