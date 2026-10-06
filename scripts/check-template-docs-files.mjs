#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The infrastructure-template docs pages must name template files that EXIST.
//
// WHY THIS EXISTS, measured (#5560). The GCP page's resources table named `cloudsql.tf` and
// `vpn.tf`; the files are `cloud-sql.tf` and `networking.tf`. It also put the GKE cluster in
// `main.tf`, which holds only the providers — the cluster is in `gke.tf`. A reader who follows the
// table to find out what a resource does opens a file that is not there, or the wrong one.
// Nothing tied the table to the directory it describes, so a rename drifted silently.
//
// WHAT IT CHECKS. Every page in apps/docs/content/docs/concepts/runner/infrastructure-templates/
// whose basename is a cloud with a template directory (`gcp.mdx` → infra/templates/project/gcp/)
// is read for:
//   · every repo path written as `infra/templates/...` — a `.tf` file, a `modules/<name>/`
//     directory or anything else — which must exist from the repo root. A link whose URL contains
//     `/infra/templates/` (a GitHub blob or tree link) is checked the same way, by the repo path
//     after that point. Any other URL is skipped, so `https://example.com/x/main.tf` is not read;
//   · every other token that ends in `.tf` (backticked or not), resolved against the page's
//     template directory; and
//   · every other `modules/<name>/` token, which must be a directory in that template directory.
// A page whose basename has NO template directory (index.mdx, argocd.mdx) must name no bare `.tf`
// file: such a page has nothing to resolve the name against, so a name there fails rather than
// passes unread. Its `infra/templates/...` paths are still checked from the repo root. The run also fails if no page maps to a template directory, so a moved docs
// folder cannot turn this into a check over nothing.
//
// WHAT IT DOES NOT CHECK, stated so it is not read as more than it is:
//   · It does not check that a row's DESCRIPTION is true of the file. That is review's job.
//   · It does not check that every template file has a row. The tables list the main resources,
//     not every `checks_*.tf`, on purpose.
//   · It reads only the directory above. A `.tf` name on any other docs page is not checked here.
//
// Usage:  node scripts/check-template-docs-files.mjs [--root <dir>] [--self-test]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SELF), "..");
const DOCS_DIR = "apps/docs/content/docs/concepts/runner/infrastructure-templates";
const TEMPLATES_DIR = "infra/templates/project";

/**
 * A `.tf` file name: path characters, then `.tf` not followed by more name — so not
 * `checks.tftest.hcl` or `x.tf.json`, but a sentence-ending `vpn.tf.` still counts.
 */
const TF_NAME = /[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.tf(?![A-Za-z0-9_]|\.[A-Za-z0-9])/g;
/** A URL, up to the first character that ends a Markdown link target or a code span. */
const URL = /https?:\/\/[^\s)`>\]"']+/g;
/** A repo path under infra/templates/, not part of a longer path. */
const REPO_PATH = /(?<![A-Za-z0-9_./-])infra\/templates\/[A-Za-z0-9_./-]*/g;
/** A module directory reference such as `modules/gke/`. */
const MODULE_REF = /(?<![A-Za-z0-9_./-])modules\/([A-Za-z0-9_-]+)\/?/g;

/** True when `p` exists and is a directory. */
function isDir(p) {
	return existsSync(p) && statSync(p).isDirectory();
}

/**
 * Check every template docs page under `root`. Returns the findings (one per bad name, with its
 * page and line) and the number of pages that mapped to a template directory.
 */
function check(root) {
	const findings = [];
	const docsDir = join(root, DOCS_DIR);
	if (!isDir(docsDir)) {
		return { findings: [{ page: DOCS_DIR, line: 0, msg: "docs directory not found" }], mapped: 0 };
	}
	let mapped = 0;
	const pages = readdirSync(docsDir).filter((f) => f.endsWith(".mdx") || f.endsWith(".md"));
	for (const page of pages.sort()) {
		const cloud = page.replace(/\.mdx?$/, "");
		const templateRel = `${TEMPLATES_DIR}/${cloud}`;
		const templateDir = join(root, templateRel);
		const hasTemplate = isDir(templateDir);
		if (hasTemplate) mapped++;
		const lines = readFileSync(join(docsDir, page), "utf8").split("\n");
		lines.forEach((raw, i) => {
			const line = i + 1;
			/** Repo paths this line names, from links and from written-out `infra/templates/...` paths. */
			const repoPaths = [];
			let text = raw.replace(URL, (url) => {
				const at = url.indexOf("/infra/templates/");
				if (at >= 0) repoPaths.push(url.slice(at + 1));
				return " ".repeat(url.length);
			});
			text = text.replace(REPO_PATH, (path) => {
				repoPaths.push(path);
				return " ".repeat(path.length);
			});
			for (const path of repoPaths) {
				const clean = path.replace(/[.,;:]+$/, "");
				if (!existsSync(join(root, clean))) {
					findings.push({ page, line, msg: `names \`${clean}\`, which does not exist` });
				}
			}
			for (const m of text.matchAll(TF_NAME)) {
				const name = m[0];
				if (!hasTemplate) {
					findings.push({
						page,
						line,
						msg: `names \`${name}\`, but ${templateRel}/ does not exist to resolve it against`,
					});
					continue;
				}
				if (!existsSync(join(templateDir, name))) {
					findings.push({ page, line, msg: `names \`${name}\`, which is not in ${templateRel}/` });
				}
			}
			if (!hasTemplate) return;
			for (const m of text.matchAll(MODULE_REF)) {
				if (!isDir(join(templateDir, "modules", m[1]))) {
					findings.push({ page, line, msg: `names \`modules/${m[1]}/\`, which is not in ${templateRel}/` });
				}
			}
		});
	}
	return { findings, mapped };
}

/** Run the check over `root`, print the result, and return the process exit code. */
function run(root) {
	const { findings, mapped } = check(root);
	if (mapped === 0 && findings.length === 0) {
		console.error(`✗ no page in ${DOCS_DIR}/ maps to a directory in ${TEMPLATES_DIR}/ — the check read nothing`);
		return 1;
	}
	if (findings.length > 0) {
		console.error(`✗ ${findings.length} template docs reference(s) name a file that does not exist:`);
		for (const f of findings) console.error(`  ${DOCS_DIR}/${f.page}:${f.line}  ${f.msg}`);
		return 1;
	}
	console.log(`✓ template docs: ${mapped} page(s) name only files that exist in their template directory`);
	return 0;
}

/**
 * Build a throwaway repo shape under a temp dir: one template directory `demo` holding `real.tf`
 * and `modules/real/`, and the docs directory with one page per entry of `pages`.
 */
function fixture(pages) {
	const dir = mkdtempSync(join(tmpdir(), "template-docs-"));
	mkdirSync(join(dir, TEMPLATES_DIR, "demo", "modules", "real"), { recursive: true });
	writeFileSync(join(dir, TEMPLATES_DIR, "demo", "real.tf"), "");
	writeFileSync(join(dir, TEMPLATES_DIR, "demo", "checks.tftest.hcl"), "");
	mkdirSync(join(dir, DOCS_DIR), { recursive: true });
	for (const [name, body] of Object.entries(pages)) writeFileSync(join(dir, DOCS_DIR, name), body);
	return dir;
}

/** Run this script as a child process against `root`; return its exit status and output. */
function runChild(root) {
	const r = spawnSync(process.execPath, [SELF, "--root", root], { encoding: "utf8" });
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Assert the real exit code of the script on planted fixtures. Returns the number of failures. */
function selfTest() {
	const cases = [
		{
			name: "a page naming only real files passes",
			pages: {
				"demo.mdx": "| `real.tf` | x |\n| `modules/real/` | y |\nsee `infra/templates/project/demo/real.tf` and `checks.tftest.hcl`, ~2 `.tf` files\n",
				"index.mdx": "no file names here\n",
			},
			wantZero: true,
		},
		{
			name: "a planted `ghost.tf` row fails",
			pages: { "demo.mdx": "| `real.tf` | x |\n| `ghost.tf` | y |\n" },
			wantZero: false,
			mustSay: "ghost.tf",
		},
		{
			name: "a planted un-backticked `vpn.tf` in prose fails",
			pages: { "demo.mdx": "The network is in vpn.tf.\n" },
			wantZero: false,
			mustSay: "vpn.tf",
		},
		{
			name: "a planted `modules/ghost/` row fails",
			pages: { "demo.mdx": "| `modules/ghost/` | y |\n" },
			wantZero: false,
			mustSay: "modules/ghost/",
		},
		{
			name: "a `.tf` name on a page with no template directory fails",
			pages: { "demo.mdx": "`real.tf`\n", "argocd.mdx": "`real.tf`\n" },
			wantZero: false,
			mustSay: "argocd.mdx",
		},
		{
			name: "a GitHub link to a real template file passes, and a link to another site is not read",
			pages: {
				"demo.mdx":
					"See [real](https://github.com/o/r/blob/dev/infra/templates/project/demo/real.tf) and [x](https://example.com/y/ghost.tf).\n",
			},
			wantZero: true,
		},
		{
			name: "a GitHub link to a planted `ghost.tf` fails",
			pages: { "demo.mdx": "[g](https://github.com/o/r/blob/dev/infra/templates/project/demo/ghost.tf)\n" },
			wantZero: false,
			mustSay: "infra/templates/project/demo/ghost.tf",
		},
		{
			name: "a path-prefixed real module passes",
			pages: { "demo.mdx": "`infra/templates/project/demo/modules/real/`\n" },
			wantZero: true,
		},
		{
			name: "a path-prefixed planted `modules/ghost/` fails",
			pages: { "demo.mdx": "`infra/templates/project/demo/modules/ghost/`\n" },
			wantZero: false,
			mustSay: "infra/templates/project/demo/modules/ghost/",
		},
		{
			name: "a docs directory mapping to no template directory fails",
			pages: { "index.mdx": "nothing\n" },
			wantZero: false,
			mustSay: "read nothing",
		},
	];
	let bad = 0;
	for (const c of cases) {
		const dir = fixture(c.pages);
		try {
			const { status, out } = runChild(dir);
			const okStatus = c.wantZero ? status === 0 : typeof status === "number" && status !== 0;
			const okText = c.mustSay === undefined || out.includes(c.mustSay);
			if (!okStatus || !okText) {
				bad++;
				console.error(`self-test FAIL: ${c.name} — exit ${status}\n${out}`);
			} else {
				console.log(`  ok  ${c.name} (exit ${status})`);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	console.log(`  ${cases.length - bad}/${cases.length} self-test cases passed`);
	return bad;
}

if (process.argv.includes("--self-test")) {
	process.exit(selfTest() ? 1 : 0);
}
const rootIdx = process.argv.indexOf("--root");
const root = rootIdx >= 0 ? resolve(process.argv[rootIdx + 1]) : REPO_ROOT;
process.exit(run(root));
