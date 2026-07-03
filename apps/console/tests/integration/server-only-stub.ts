// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Empty stand-in for the `server-only` package. The real query modules
// (lib/queries/usage-counts, lib/billing/ai-quota) `import "server-only"`, which throws
// outside an RSC bundler. The integration Vitest config aliases `server-only` here so those
// modules import cleanly in the node test runner.
export {};
