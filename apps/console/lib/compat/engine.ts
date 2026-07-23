// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The TS mirror of the pure compat engine (packages/core/compat/compat.go). It
// evaluates a proposed config against the generated matrix into a CompatReport
// with byte-for-byte the same verdict + control statuses the Go engine produces
// for the same subject (the contract-lock discipline). Pure + deterministic —
// no I/O, no clock — so config-time UI and the apply gate share one truth.

import type {
	CompatAddOnRef,
	CompatComponentRef,
	CompatControlResult,
	CompatOverride,
	CompatReport,
	CompatStatus,
	CompatSubject,
	CompatSummary,
} from "@/types/compat.types";
import { MATRIX } from "./generated/matrix";
import type { ComponentRelease, K8sRange } from "./generated/matrix";

/**
 * Evaluate a proposed config against the embedded matrix, returning a structured
 * CompatReport. Mirrors compat.Evaluate: emits COMPAT-K8S-CLOUD-<PROVIDER>,
 * COMPAT-COMPONENT-<ID>, and COMPAT-ADDON-<ID> controls, and never reports a pass
 * on something the matrix has no data for (not_evaluable, honest).
 */
export function evaluate(subject: CompatSubject): CompatReport {
	const controls: CompatControlResult[] = [];
	for (const provider of subject.providers ?? []) {
		controls.push(evalK8sCloud(provider, subject.k8sVersion));
	}
	for (const c of subject.components ?? []) {
		controls.push(evalComponent(subject.k8sVersion, c));
	}
	for (const a of subject.addons ?? []) {
		controls.push(evalAddOn(subject.k8sVersion, a));
	}
	return finalize(controls);
}

/** Whether a blocking report should stop a real apply (only a hard fail blocks). */
export function isBlocking(report: CompatReport): boolean {
	return report.verdict === "fail";
}

/**
 * The IDs of controls that FAILED and are NOT covered by a valid override. A
 * non-empty result means the apply must stay blocked. Mirrors Report.Unwaived.
 */
export function unwaived(report: CompatReport, override?: CompatOverride | null): string[] {
	return report.controls
		.filter((c) => c.status === "fail" && !covers(override, c.id))
		.map((c) => c.id);
}

/** Whether an override currently waives a control ID (false when expired). */
function covers(override: CompatOverride | null | undefined, id: string): boolean {
	if (!override) return false;
	if (override.expiry && new Date(override.expiry).getTime() < Date.now()) return false;
	return override.controls.includes(id);
}

/** Checks that the cluster Kubernetes minor is offered by the cloud. */
function evalK8sCloud(provider: string, k8s: string | undefined): CompatControlResult {
	const c: CompatControlResult = {
		id: `COMPAT-K8S-CLOUD-${provider.toUpperCase()}`,
		title: `Kubernetes availability on ${provider}`,
		severity: "high",
		status: "not_evaluable",
	};
	const cloud = MATRIX.k8s_cloud[provider];
	if (!cloud || cloud.supported.length === 0) {
		c.coverage = `no supported Kubernetes versions recorded for cloud "${provider}"`;
		return c;
	}
	const kv = parseMinor(k8s);
	if (!kv) {
		c.coverage = "cluster Kubernetes version is unset or unparseable";
		return c;
	}
	if (cloud.supported.some((sv) => minorEquals(parseMinor(sv), kv))) {
		c.status = "pass";
		return c;
	}
	c.status = "fail";
	c.findings = [
		{
			address: `${provider}/k8s@${k8s}`,
			message: `Kubernetes ${k8s} is not offered by ${provider} (supported: ${cloud.supported.join(", ")})`,
		},
	];
	return c;
}

/** Checks the cluster Kubernetes minor against a component version's window. */
function evalComponent(k8s: string | undefined, ref: CompatComponentRef): CompatControlResult {
	const c: CompatControlResult = {
		id: `COMPAT-COMPONENT-${ref.id.toUpperCase()}`,
		title: `${ref.id} ${ref.version} ↔ Kubernetes`,
		severity: "high",
		status: "not_evaluable",
	};
	const rel = findRelease(ref.id, ref.version);
	if (!rel) {
		c.coverage = `no compatibility data recorded for ${ref.id} ${ref.version}`;
		return c;
	}
	applyRangeResult(c, k8s, rel.k8s_min, rel.k8s_max, `${ref.id}@${ref.version}`);
	return c;
}

/** Checks the cluster Kubernetes minor against an add-on chart's window. */
function evalAddOn(k8s: string | undefined, ref: CompatAddOnRef): CompatControlResult {
	const c: CompatControlResult = {
		id: `COMPAT-ADDON-${ref.id.toUpperCase()}`,
		title: `add-on ${ref.id} ↔ Kubernetes`,
		severity: "medium",
		status: "not_evaluable",
	};
	const rng: K8sRange | undefined = MATRIX.addon_k8s[ref.id];
	if (!rng) {
		c.coverage = `add-on "${ref.id}" is not in the compatibility matrix`;
		return c;
	}
	applyRangeResult(c, k8s, rng.k8s_min, rng.k8s_max, ref.id);
	return c;
}

/** Writes a range-check outcome onto a control (finding on fail, coverage on not_evaluable). */
function applyRangeResult(
	c: CompatControlResult,
	k8s: string | undefined,
	min: string,
	max: string,
	address: string,
): void {
	const { status, detail } = checkK8sRange(k8s, min, max);
	c.status = status;
	if (status === "fail") {
		c.findings = [
			{ address, message: `requires Kubernetes ${rangeLabel(min, max)}, cluster is ${k8s}` },
		];
	} else if (status === "not_evaluable") {
		c.coverage = detail;
	}
}

/**
 * The status of a cluster Kubernetes minor against a [min, max] window. Both
 * bounds empty means no window is recorded (not_evaluable, never a pass); an empty
 * single bound is unbounded on that side.
 */
function checkK8sRange(
	k8s: string | undefined,
	min: string,
	max: string,
): { status: CompatStatus; detail: string } {
	if (!min && !max) {
		return { status: "not_evaluable", detail: "no Kubernetes compatibility range recorded" };
	}
	const kv = parseMinor(k8s);
	if (!kv) {
		return { status: "not_evaluable", detail: "cluster Kubernetes version is unset or unparseable" };
	}
	if (min) {
		const mn = parseMinor(min);
		if (!mn) return { status: "not_evaluable", detail: `recorded lower bound "${min}" is unparseable` };
		if (cmpMinor(kv, mn) < 0) return { status: "fail", detail: "" };
	}
	if (max) {
		const mx = parseMinor(max);
		if (!mx) return { status: "not_evaluable", detail: `recorded upper bound "${max}" is unparseable` };
		if (cmpMinor(kv, mx) > 0) return { status: "fail", detail: "" };
	}
	return { status: "pass", detail: "" };
}

/** Renders a [min, max] window for a human message ("1.33+", "≤1.32", "1.34–1.36"). */
function rangeLabel(min: string, max: string): string {
	if (min && max) return `${min}–${max}`;
	if (min) return `${min}+`;
	if (max) return `≤${max}`;
	return "any";
}

/** A parsed (major, minor) Kubernetes version; patch is ignored. */
type Minor = { major: number; minor: number };

/** Parses "1.35" / "1.35.6" / "v1.35" into its (major, minor), ignoring patch + leading "v". */
function parseMinor(v: string | undefined): Minor | null {
	if (!v) return null;
	const trimmed = v.trim().replace(/^v/, "");
	const parts = trimmed.split(".");
	if (parts.length < 2) return null;
	const major = Number(parts[0]);
	const minor = Number(parts[1]);
	if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
	return { major, minor };
}

function minorEquals(a: Minor | null, b: Minor): boolean {
	return a !== null && a.major === b.major && a.minor === b.minor;
}

/** Orders two parsed minors: -1 if a<b, 0 if equal, 1 if a>b. */
function cmpMinor(a: Minor, b: Minor): number {
	if (a.major !== b.major) return a.major < b.major ? -1 : 1;
	if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
	return 0;
}

/**
 * Tallies the summary and computes the verdict by precedence
 * fail > warn > not_evaluable > pass (an empty report is not_evaluable).
 */
function finalize(controls: CompatControlResult[]): CompatReport {
	const summary: CompatSummary = { pass: 0, fail: 0, warn: 0, not_evaluable: 0 };
	for (const c of controls) {
		if (c.status === "pass") summary.pass++;
		else if (c.status === "fail") summary.fail++;
		else if (c.status === "warn") summary.warn++;
		else summary.not_evaluable++;
	}
	let verdict: CompatStatus;
	if (summary.fail > 0) verdict = "fail";
	else if (summary.warn > 0) verdict = "warn";
	else if (summary.not_evaluable > 0) verdict = "not_evaluable";
	else if (summary.pass > 0) verdict = "pass";
	else verdict = "not_evaluable";
	return { verdict, catalog_version: MATRIX.catalog_version, controls, summary };
}

/** Finds a component's recorded release by version. */
function findRelease(componentId: string, version: string): ComponentRelease | undefined {
	return MATRIX.components
		.find((c) => c.id === componentId)
		?.versions.find((r) => r.version === version);
}
