// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #940b (#969): barrel shim over the generated catalog baseline (#1126). The per-provider messaging
// service configuration is re-exported verbatim from the single source of truth — same path + symbol,
// ZERO behaviour change. #940c deletes this shim and repoints importers straight at the generated module.
export { MESSAGING } from "./generated/catalog";
