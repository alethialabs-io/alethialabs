// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Connector-assets drift guard. The cloud-connector setup artifacts have ONE source of
// truth — `infra/connector/` — but the same bytes are served from three places:
//   1. the public S3 bucket (infra/connector-assets uploads them straight from infra/connector),
//   2. apps/console/public/ (the self-host fallback origin + the in-app download buttons),
//   3. the CLI embed (apps/cli/internal/connector — checked separately by the Go build).
// This guard keeps (1)↔(2) honest: the committed public copies must be byte-identical to the
// canonical infra/connector sources. Run: node scripts/check-connector-assets.mjs (exit 1 on drift).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// canonical source (infra/connector) → served copy (apps/console/public)
const PAIRS = [
	[
		"infra/connector/azure/alethia-azure-setup.sh",
		"apps/console/public/alethia-azure-setup.sh",
	],
	[
		"infra/connector/alibaba/alethia-alibaba-setup.sh",
		"apps/console/public/alethia-alibaba-setup.sh",
	],
	[
		"infra/connector/gcp/alethia-gcp-setup.sh",
		"apps/console/public/alethia-gcp-setup.sh",
	],
	[
		"infra/connector/aws/alethia-bootstrap.yaml",
		"apps/console/public/alethia-bootstrap.yaml",
	],
	[
		"infra/connector/aws/alethia-bootstrap.tf",
		"apps/console/public/connector-terraform/aws.tf",
	],
	[
		"infra/connector/gcp/main.tf",
		"apps/console/public/connector-terraform/gcp.tf",
	],
	[
		"infra/connector/azure/main.tf",
		"apps/console/public/connector-terraform/azure.tf",
	],
	[
		"infra/connector/alibaba/main.tf",
		"apps/console/public/connector-terraform/alibaba.tf",
	],
];

/** sha256 of a file, or null if it doesn't exist. */
function sha256(path) {
	if (!existsSync(path)) return null;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const failures = [];
for (const [src, copy] of PAIRS) {
	const a = sha256(src);
	const b = sha256(copy);
	if (a === null) failures.push(`missing canonical source: ${src}`);
	else if (b === null) failures.push(`missing public copy: ${copy}`);
	else if (a !== b) failures.push(`${copy} is out of sync with ${src}`);
}

if (failures.length > 0) {
	console.error("✗ connector-assets out of sync (source of truth: infra/connector/):");
	for (const f of failures) console.error(`  • ${f}`);
	console.error(
		"\n  The public copies must be byte-identical to infra/connector/.\n" +
			"  Run `pnpm sync:connector-assets` and commit the result.\n",
	);
	process.exit(1);
}

console.log(
	`✓ connector-assets OK — ${PAIRS.length} artifacts byte-identical across infra/connector/ and apps/console/public/`,
);
