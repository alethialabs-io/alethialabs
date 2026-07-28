// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One add-on's Kubernetes compatibility, shaped for a chip or a badge.
//
// A thin adapter over the SAME pure engine the config-time resolver (#1218) and the apply gate
// (#1215) use — `evalAddOn` + `rangeLabel`, not a second implementation of range math. If the matrix
// or the comparison rules move, every surface moves with them.
//
// Client-safe: `lib/compat` has no `"use server"` and `MATRIX` is a static object. That matters
// because the canvas must re-judge as the user edits the cluster's Kubernetes version live, long
// before any job (and therefore any stored `config_snapshot.compat`) exists.

import { evalAddOn, rangeLabel } from "./engine";
import { MATRIX } from "./generated/matrix";
import type { CompatStatus } from "@/types/compat.types";

export interface AddOnCompat {
	status: CompatStatus;
	/** The recorded window as a human label — "1.25+", "≤1.32", "1.34–1.36", or "any". */
	window: string;
	/** One sentence for a tooltip: why this verdict. Never empty. */
	note: string;
}

/**
 * Judge `addonId` against a cluster Kubernetes version.
 *
 * `k8sVersion` may legitimately be undefined — a design with no cluster yet, or a cluster whose
 * version is unset. That yields `not_evaluable`, never a pass: the whole point of the tri-state is
 * that "we could not check" must not read as "fine".
 *
 * Note that `not_evaluable` is the COMMON case, not an edge: at the time of writing 9 of the 19
 * catalogued add-ons have no window recorded in `matrix.json` at all. Any UI built on this needs a
 * real third state — a binary compatible/incompatible would be a lie for half the catalogue.
 */
export function addonCompat(
	addonId: string,
	k8sVersion: string | undefined,
): AddOnCompat {
	const control = evalAddOn(k8sVersion, { id: addonId });
	const range = MATRIX.addon_k8s[addonId];
	const window = range ? rangeLabel(range.k8s_min, range.k8s_max) : "any";

	if (control.status === "fail") {
		return {
			status: "fail",
			window,
			note:
				control.findings?.[0]?.message ??
				`requires Kubernetes ${window}, cluster is ${k8sVersion}`,
		};
	}
	if (control.status === "not_evaluable") {
		return {
			status: "not_evaluable",
			window,
			// `coverage` is the engine's own honesty field — it says what could not be judged.
			note: control.coverage ?? "Kubernetes compatibility could not be checked.",
		};
	}
	return {
		status: control.status,
		window,
		note: `Supports Kubernetes ${window}; cluster is ${k8sVersion}.`,
	};
}
