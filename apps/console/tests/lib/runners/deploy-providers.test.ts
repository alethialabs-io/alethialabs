// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The drift guard for RUNNER_DEPLOY_PROVIDERS. The list is what the console gates on; the runner
// gates on the DIRECTORY NAMES under `infra/templates/runner/`. Two hand-maintained literals for
// one fact is how a boundary starts denying (or accepting) silently, so this test derives the
// truth from the filesystem and reds the moment the two disagree — adding a template directory is
// then the single edit that widens the list.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	isRunnerDeployProvider,
	RUNNER_DEPLOY_PROVIDERS,
	RUNNER_DEPLOY_PROVIDERS_LABEL,
	runnerDeployUnsupportedMessage,
} from "@/lib/runners/deploy-providers";

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/lib/runners → tests/lib → tests → console → apps → repo root
const TEMPLATES_DIR = join(
	__dirname,
	"../../../../..",
	"infra/templates/runner",
);

describe("RUNNER_DEPLOY_PROVIDERS", () => {
	it("is exactly the set of runner template directories", () => {
		const dirs = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
		expect(dirs).toEqual([...RUNNER_DEPLOY_PROVIDERS].sort());
	});

	it("narrows a supported cloud and rejects the rest", () => {
		expect(isRunnerDeployProvider("aws")).toBe(true);
		for (const other of ["gcp", "azure", "alibaba", "hetzner", ""])
			expect(isRunnerDeployProvider(other)).toBe(false);
	});

	it("names the cloud that was asked for and the ones that work", () => {
		const message = runnerDeployUnsupportedMessage("gcp");
		expect(message).toContain("gcp");
		expect(message).toContain(RUNNER_DEPLOY_PROVIDERS_LABEL);
		// The way out is the self-hosted path, and the copy has to say so.
		expect(message).toMatch(/register a self-hosted runner/i);
	});
});
