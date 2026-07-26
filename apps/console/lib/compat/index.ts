// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The compat seam's TS surface: the pure engine + the generated matrix. Downstream
// units (config-time warn resolver #1218, apply gate render #1219) import from here.
export { evaluate, isBlocking, unwaived } from "./engine";
export { MATRIX } from "./generated/matrix";
export type {
	CloudK8s,
	Component,
	ComponentRelease,
	K8sRange,
	Matrix,
	StaticCoupling,
} from "./generated/matrix";
export type {
	CompatAddOnRef,
	CompatComponentRef,
	CompatControlResult,
	CompatFinding,
	CompatOverride,
	CompatReport,
	CompatSeverity,
	CompatStatus,
	CompatSubject,
	CompatSummary,
} from "@/types/compat.types";
export { COMPAT_CONTROL_GATE_ID } from "@/types/compat.types";
