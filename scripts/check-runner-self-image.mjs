// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Guard: the runner's own image ref is baked correctly into every published runner image (#1787).
//
// `packages/core/selfimage` resolves the ref from ALETHIA_RUNNER_SELF_IMAGE, which each leaf
// Dockerfile sets from a SELF_IMAGE build arg that the publishing workflow supplies. Three ways
// that goes wrong, all of them silent:
//
//   1. A NEW leaf Dockerfile forgets the ARG/ENV pair. Its image resolves "" and every keyless /
//      xacct render fails closed on it — which is exactly the #1787 bug, one image at a time.
//   2. The workflow bakes the WRONG image name — `runner-aws` into `runner-gcp`. The ref is
//      pullable, so nothing errors; the cluster just runs the wrong sidecar forever.
//   3. The workflow bakes a PER-ARCH tag (`:${sha}-amd64`). This ref becomes a sidecar on the
//      CUSTOMER's nodes, so an arm64-only manifest is unpullable on amd64 ones — the runner-arch
//      churn incident (2026-07-22) one layer out.
//
// Neither a build nor a test catches any of these: the image builds, the binary runs, and the
// damage appears on someone else's cluster. Hence a guard.
//
// Run: `node scripts/check-runner-self-image.mjs` (wired into the `guards` CI job).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RUNNER_DIR = "apps/runner";
const WORKFLOW = ".github/workflows/deploy-console.yml";

// Dockerfile.base performs the one `go build` shared by every variant and cannot know which image
// it will become, so it must NOT carry the ARG. That is a rule, not an oversight — assert it.
const BASE = "Dockerfile.base";

const errors = [];
const note = (msg) => errors.push(msg);

// ── 1. every leaf Dockerfile declares the pair ────────────────────────────────
const dockerfiles = readdirSync(RUNNER_DIR).filter((f) => f === "Dockerfile" || f.startsWith("Dockerfile."));
const leaves = dockerfiles.filter((f) => f !== BASE);

if (leaves.length === 0) {
	note(`no leaf Dockerfiles found under ${RUNNER_DIR}/ — this guard is looking in the wrong place`);
}

for (const f of leaves) {
	const src = readFileSync(join(RUNNER_DIR, f), "utf8");
	if (!/^ARG SELF_IMAGE=""$/m.test(src)) {
		note(
			`${RUNNER_DIR}/${f}: missing \`ARG SELF_IMAGE=""\`. The default must be EMPTY — a locally ` +
				`built image has no published ref, and baking a guessed one names a different image than ` +
				`the one running.`,
		);
	}
	if (!/^ENV ALETHIA_RUNNER_SELF_IMAGE=\$\{SELF_IMAGE\}$/m.test(src)) {
		note(`${RUNNER_DIR}/${f}: missing \`ENV ALETHIA_RUNNER_SELF_IMAGE=\${SELF_IMAGE}\``);
	}
}

if (dockerfiles.includes(BASE)) {
	const base = readFileSync(join(RUNNER_DIR, BASE), "utf8");
	if (/SELF_IMAGE|ALETHIA_RUNNER_SELF_IMAGE/.test(base)) {
		note(
			`${RUNNER_DIR}/${BASE}: must NOT set the self-image — it is shared by every variant and ` +
				`cannot know which one it becomes. Put the ARG/ENV in each leaf Dockerfile.`,
		);
	}
}

// ── 2 & 3. the workflow bakes the right image, at a multi-arch tag ────────────
const wf = readFileSync(WORKFLOW, "utf8").split("\n");

/**
 * The repository segment of an image reference in a workflow line, or null.
 *
 * `${{ … }}` expressions contain spaces and dots, so they cannot be split on naively — collapse
 * each to a single space-free token first, then take everything after the registry prefix up to
 * the tag separator. Handles both `tags: <prefix>/<repo>:<tag>` and
 * `outputs: type=image,name=<prefix>/<repo>,…`.
 */
function repoOf(line) {
	const flat = line.replace(/\$\{\{\s*([^}]*?)\s*\}\}/g, (_, expr) => `⟨${expr.replace(/\s+/g, "")}⟩`);
	const m = flat.match(/⟨env\.IMAGE_PREFIX⟩\/([^:,\s]+)/);
	return m ? m[1] : null;
}

const selfImageLines = wf
	.map((line, i) => ({ line: line.trim(), n: i + 1 }))
	.filter(({ line }) => line.startsWith("SELF_IMAGE="));

if (selfImageLines.length === 0) {
	note(`${WORKFLOW}: no SELF_IMAGE build-arg found — published images would resolve an empty ref`);
}

for (const { line, n } of selfImageLines) {
	const value = line.slice("SELF_IMAGE=".length);

	// (3) a per-arch tag must never be baked.
	if (/-(amd64|arm64)\s*$/.test(value)) {
		note(
			`${WORKFLOW}:${n}: SELF_IMAGE bakes a PER-ARCH tag (${value}). It must be the final ` +
				`multi-arch tag — this ref is rendered as a sidecar on the customer's nodes, and an ` +
				`arch-specific manifest is unpullable on the other architecture.`,
		);
	}

	// (2) the baked repository must match the image this job actually pushes. Find the nearest
	// following `tags:`/`outputs:` line — the same anchor the job itself uses.
	const dest = wf.slice(n, n + 8).find((l) => /^\s*(tags|outputs):/.test(l)) ?? "";
	const bakedRepo = repoOf(value);
	const destRepo = repoOf(dest);

	if (destRepo === null) {
		note(`${WORKFLOW}:${n}: cannot tell which image this job pushes — no tags:/outputs: within 8 lines`);
	} else if (bakedRepo !== destRepo) {
		note(
			`${WORKFLOW}:${n}: SELF_IMAGE bakes \`${bakedRepo}\` into a job that pushes \`${destRepo}\`. ` +
				`The image would run the wrong sidecar, and nothing would error.`,
		);
	}
}

if (errors.length > 0) {
	console.error("✗ runner self-image guard\n");
	for (const e of errors) console.error(`  • ${e}\n`);
	process.exit(1);
}

console.log(
	`✓ runner self-image — ${leaves.length} leaf Dockerfile(s) bake the ref, ` +
		`${selfImageLines.length} build job(s) supply a matching multi-arch tag.`,
);
