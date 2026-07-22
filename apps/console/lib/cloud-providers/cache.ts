// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #940b (#969): barrel shim over the generated catalog baseline (#1126). The cache node-type catalog,
// its default, and the cross-provider node map are re-exported verbatim from the single source of
// truth — same paths + symbols, ZERO behaviour change. #940c deletes this shim and repoints importers
// straight at the generated module.
export { CACHE_NODE_TYPES, DEFAULT_CACHE_NODE, CACHE_NODE_MAP } from "./generated/catalog";
