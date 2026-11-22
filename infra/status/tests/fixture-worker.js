// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in bundle for checks.tftest.hcl, so the plan can run without `pnpm -F @repo/status build`.
export default { async fetch() { return new Response("fixture"); } };
