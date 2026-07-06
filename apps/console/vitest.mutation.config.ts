// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Vitest config used ONLY by Stryker mutation runs. Stryker sandboxes apps/console on its own, so
// the CLI wire-contract suite — which reads sibling fixtures in packages/core/api/testdata — can't
// resolve them in the sandbox. Exclude just that cross-package test here (it's fully verified by the
// normal `pnpm test`); its source (lib/validations/cli-contract.ts) is correspondingly dropped from
// Stryker's mutate scope in stryker.config.mjs. Everything else mutates exactly as in the unit run.

import { mergeConfig } from "vitest/config";
import base from "./vitest.config";

export default mergeConfig(base, {
	test: {
		exclude: ["**/tests/validations/cli-contract.test.ts"],
	},
});
