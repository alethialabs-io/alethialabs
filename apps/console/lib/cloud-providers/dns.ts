// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #940b (#969): barrel shim over the generated catalog baseline (#1126). The per-provider WAF + managed
// certificate options are re-exported verbatim from the single source of truth — same paths + symbols,
// ZERO behaviour change. #940c deletes this shim and repoints importers straight at the generated module.
export { WAF_OPTIONS, CERT_OPTIONS } from "./generated/catalog";
