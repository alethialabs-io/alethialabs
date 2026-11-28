#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fails when this PUBLIC repository gains company content: material that belongs to Alethia Labs
// the company, not to Alethia the product. The policy it enforces is docs/public-surface.md.
//
// WHY THIS EXISTS, measured. An audit of `dev` on 2026-11-28 (8,927 tracked files) found about
// 1,100 that a person who clones the product never needs: the company's own invoicing and VAT
// filing, the marketing site and blog, the infrastructure that runs the company's accounts, the
// hosted production deploy and the agents' internal ops notes. None of it was put here by
// mistake. Each piece arrived because this was the only repo, and nothing said it should not.
// The cleanup is a board of lanes (#7967 and the issues blocked on it). This guard is the part
// that stops the next addition while they land, and stops a moved directory from coming back.
//
// HOW. Each CLASS below names path prefixes, why they are company content and where they go.
// scripts/public-surface-ledger.json records, per class, every tracked file that matches today.
// The check runs both ways:
//   · a tracked file that matches a class and is NOT in the ledger fails. That is new company
//     content; put it in its destination instead;
//   · a ledger entry whose file is no longer tracked fails too. A lane that moves a directory out
//     removes its entries in the same diff (`--prune` does that, and only that), so the ledger
//     only ever shrinks and its size is the remaining work.
// There is deliberately no flag that ADDS entries. Growing the ledger is a hand edit in a
// reviewed diff, which is the point.
//
// WHAT IS DELIBERATELY NOT COVERED, so nobody reads this as more than it is:
//   · git HISTORY. Moving a file does not remove it from public history, and the history is not
//     rewritten (founder decision 2026-11-28).
//   · CONTENT inside product files: an internal hostname, an account id or a note in a comment.
//     That is a text question, and the classes here are a path question. check:forbidden-names
//     and gitleaks cover the text side, each for its own stated set.
//   · The ENTERPRISE boundary: commercial code outside ee/ is check:open-core's question.
//   · Paths no class names. The classes are a hand-written domain taken from the 11-28 audit. A
//     new kind of company content needs a new class here, and only a person can notice that.
//
// Usage:  node scripts/check-public-surface.mjs [--prune] [--self-test]

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const LEDGER = "scripts/public-surface-ledger.json";

/**
 * The classes of company content. A prefix ending in "/" names a directory; any other prefix
 * names a file, or a family of files that share the start of a name.
 */
export const CLASSES = [
	{
		id: "staff-app",
		why: "The staff admin app operates the hosted service; it lives in the private web repo.",
		goes: "alethialabs-io/web (admin split, #7944)",
		prefixes: ["apps/admin/"],
	},
	{
		id: "marketing",
		why: "The marketing site, blog, status page and brand assets describe the company, not the product.",
		goes: "alethialabs-io/web (#7969)",
		prefixes: [
			"apps/marketing/",
			"apps/blog/",
			"packages/status/",
			"packages/assets/static/mkt-assets/",
			"infra/status/",
			".github/workflows/infra-status.yml",
			".claude/skills/alethia-design/",
		],
	},
	{
		id: "company-finance",
		why: "Alethia Labs' own invoicing, VAT filing and legal facts; a self-hoster never runs them.",
		goes: "a private package behind a console billing interface (#7972)",
		prefixes: [
			"packages/nra/",
			"packages/legal/",
			"apps/console/lib/billing/factura/",
			"apps/console/lib/billing/nra/",
			"apps/console/scripts/nra-",
			"apps/console/scripts/factura-",
		],
	},
	{
		id: "company-estate-infra",
		why: "Infrastructure that runs the company's own accounts, mail, backups and books.",
		goes: "a private ops repo (#7970)",
		prefixes: [
			"infra/aws-oidc/",
			"infra/backup-account/",
			"infra/books-archive/",
			"infra/email-ses/",
			"infra/email-ses-account/",
			"infra/github/",
			"infra/sandbox/",
			"infra/e2e-issuer/",
			"apps/e2e-issuer/",
			"scripts/spend-report/",
			"scripts/gmail-inbox/",
			".github/workflows/infra-aws-oidc.yml",
			".github/workflows/infra-backup-account.yml",
			".github/workflows/infra-books-archive.yml",
			".github/workflows/infra-email-ses.yml",
			".github/workflows/infra-email-ses-account.yml",
			".github/workflows/infra-sandbox.yml",
			".github/workflows/infra-e2e-issuer.yml",
			".github/workflows/deploy-e2e-issuer.yml",
			".github/workflows/spend-report.yml",
			".github/workflows/restore-drill.yml",
		],
	},
	{
		id: "hosted-prod-deploy",
		why: "The deploy of the hosted service. A self-hoster uses deploy/selfhost, not this.",
		goes: "designed in #7971 (the box runs compose from this checkout today)",
		prefixes: [
			"deploy/prod/",
			"deploy/analytics/",
			"infra/cp-hetzner/",
			".github/workflows/deploy-console.yml",
			"scripts/ci/deploy-console-assemble-env.sh",
		],
	},
	{
		id: "company-ops-notes",
		why: "The agents' internal programme ledger, coordination rules and credential broker.",
		goes: "private, per the harness curation (#7975)",
		prefixes: ["PROGRAMME.md", ".claude/COORDINATION.md", "scripts/creds/", "scripts/creds.py"],
	},
	{
		id: "dead",
		why: "Left over from before Alethia; nothing builds or reads it.",
		goes: "deleted (#7968)",
		prefixes: ["Formula/"],
	},
];

/** The class a path belongs to, or null when none names it. */
export function classOf(file, classes = CLASSES) {
	for (const c of classes) {
		if (c.prefixes.some((p) => file.startsWith(p))) return c.id;
	}
	return null;
}

/**
 * Compares the tracked files with the ledger. Answers the new company files (tracked, classed,
 * not in the ledger) and the stale entries (in the ledger, no longer tracked or no longer classed).
 */
export function compare(tracked, ledger, classes = CLASSES) {
	const fresh = [];
	const seen = new Set();
	for (const f of tracked) {
		const id = classOf(f, classes);
		if (!id) continue;
		seen.add(`${id}\0${f}`);
		if (!(ledger[id] ?? []).includes(f)) fresh.push({ id, file: f });
	}
	const stale = [];
	for (const [id, files] of Object.entries(ledger)) {
		if (id.startsWith("$")) continue;
		for (const f of files) if (!seen.has(`${id}\0${f}`)) stale.push({ id, file: f });
	}
	return { fresh, stale };
}

/** The tracked files of the repository at `cwd`. */
function trackedFiles(cwd) {
	return execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8", maxBuffer: 1 << 28 })
		.split("\0")
		.filter(Boolean);
}

/** Reads the ledger; an absent class reads as empty. */
function readLedger(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

/** Runs the check at `root`; answers the exit code. With `prune`, removes stale entries only. */
function run(root, { prune = false, out = console } = {}) {
	const ledgerPath = path.join(root, LEDGER);
	const ledger = readLedger(ledgerPath);
	const { fresh, stale } = compare(trackedFiles(root), ledger);
	if (prune && stale.length) {
		for (const { id, file } of stale) ledger[id] = ledger[id].filter((f) => f !== file);
		writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, "\t")}\n`);
		out.log(`pruned ${stale.length} stale ledger entr${stale.length === 1 ? "y" : "ies"}`);
		return fresh.length ? report(fresh, [], out) : 0;
	}
	return report(fresh, stale, out);
}

/** Prints the findings; answers the exit code. */
function report(fresh, stale, out) {
	if (!fresh.length && !stale.length) {
		const left = CLASSES.map((c) => c.id).join(", ");
		out.log(`✓ public surface: no new company content (classes: ${left})`);
		return 0;
	}
	for (const { id, file } of fresh) {
		const c = CLASSES.find((k) => k.id === id);
		out.error(`✗ ${file}: new ${id} content in the public repo. ${c.why} It goes to ${c.goes}.`);
	}
	for (const { id, file } of stale) {
		out.error(`✗ ${LEDGER}: "${file}" (${id}) is no longer tracked; run with --prune to drop it.`);
	}
	out.error("Policy: docs/public-surface.md");
	return 1;
}

/** Exercises the guard against a throwaway repo; exits non-zero on the first wrong answer. */
function selfTest() {
	const dir = mkdtempSync(path.join(tmpdir(), "public-surface-"));
	const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
	const quiet = { log() {}, error() {} };
	const write = (f, s = "x\n") => {
		execFileSync("mkdir", ["-p", path.dirname(path.join(dir, f))]);
		writeFileSync(path.join(dir, f), s);
	};
	const expect = (name, got, want) => {
		if (got !== want) {
			rmSync(dir, { recursive: true, force: true });
			console.error(`self-test FAILED: ${name}: exit ${got}, wanted ${want}`);
			process.exit(1);
		}
	};
	try {
		git("init", "-q");
		write("apps/console/page.tsx");
		write("apps/marketing/page.tsx");
		write(LEDGER, `${JSON.stringify({ marketing: ["apps/marketing/page.tsx"] })}\n`);
		git("add", "-A");
		expect("a ledgered file passes", run(dir, { out: quiet }), 0);

		write("apps/blog/post.mdx");
		git("add", "-A");
		expect("a new classed file fails", run(dir, { out: quiet }), 1);
		git("rm", "-q", "-f", "apps/blog/post.mdx");

		write("packages/legal/facts.ts");
		git("add", "-A");
		expect("a file in another class fails", run(dir, { out: quiet }), 1);
		git("rm", "-q", "-f", "packages/legal/facts.ts");

		git("rm", "-q", "-f", "apps/marketing/page.tsx");
		expect("a stale ledger entry fails", run(dir, { out: quiet }), 1);
		expect("--prune clears it", run(dir, { prune: true, out: quiet }), 0);
		expect("and it stays clear", run(dir, { out: quiet }), 0);
		const pruned = readLedger(path.join(dir, LEDGER));
		expect("--prune removed exactly that entry", pruned.marketing.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	console.log("self-test passed: 7 cases");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = new Set(process.argv.slice(2));
	if (args.has("--self-test")) selfTest();
	else process.exit(run(process.cwd(), { prune: args.has("--prune") }));
}
