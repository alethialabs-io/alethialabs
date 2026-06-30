// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Fix-it for check-connector-assets.mjs: copy the canonical connector setup artifacts from
// `infra/connector/` (the single source of truth) into `apps/console/public/` so the served
// copies stay byte-identical. The S3 bucket (infra/connector-assets) uploads from the same
// sources, so syncing here keeps all serving paths in lock-step.
// Run: node scripts/sync-connector-assets.mjs

import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const PAIRS = [
	[
		"infra/connector/azure/alethia-azure-setup.sh",
		"apps/console/public/alethia-azure-setup.sh",
	],
	[
		"infra/connector/gcp/alethia-gcp-setup.sh",
		"apps/console/public/alethia-gcp-setup.sh",
	],
	[
		"infra/connector/aws/alethia-bootstrap.yaml",
		"apps/console/public/alethia-bootstrap.yaml",
	],
];

let synced = 0;
for (const [src, copy] of PAIRS) {
	const before = (() => {
		try {
			return readFileSync(copy, "utf8");
		} catch {
			return null;
		}
	})();
	const next = readFileSync(src, "utf8");
	if (before !== next) {
		writeFileSync(copy, next);
		console.log(`  synced ${copy}`);
		synced++;
	}
}

console.log(
	synced === 0
		? "✓ connector-assets already in sync — nothing to do"
		: `✓ synced ${synced} connector artifact(s) from infra/connector/ → apps/console/public/`,
);
