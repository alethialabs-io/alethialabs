// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #940b (#969): barrel shim. The compute catalog (instance types, k8s versions, autoscaler, the
// cross-provider instance map) is now generated from the single source of truth
// (packages/core/catalog/catalog.json → generated/catalog.ts, #1126) and re-exported here verbatim,
// so importers keep the same paths + symbols with ZERO behaviour change. #940c deletes this shim and
// repoints importers straight at the generated module.
export {
	INSTANCE_TYPES,
	K8S_VERSIONS,
	AUTOSCALER,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	INSTANCE_TYPE_MAP,
} from "./generated/catalog";
