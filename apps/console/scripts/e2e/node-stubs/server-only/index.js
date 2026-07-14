// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// No-op stub so the console server modules (which `import "server-only"`) load under a plain
// Node/tsx process — outside Next.js, the bare `server-only` specifier is otherwise unresolvable
// (Next aliases it in its bundler). Reached ONLY via NODE_PATH from the A0.5 e2e finalize shim;
// never on any real build path. See scripts/e2e/finalize-deployment.ts.
module.exports = {};
