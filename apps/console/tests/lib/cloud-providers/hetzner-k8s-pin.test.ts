// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hetzner installs one Kubernetes version, the Talos pin, and never reads `cluster_version` (#5366).
// These pin the console's copy of that pin to the template it comes from, and the three answers the
// console derives from it: the minor, the conflict test, and the version a card shows.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	displayedK8sVersion,
	HETZNER_K8S_MINOR,
	HETZNER_K8S_VERSION,
	hetznerVersionConflicts,
	k8sMinor,
} from "@/lib/cloud-providers/hetzner-k8s-pin";

describe("the Hetzner Kubernetes pin", () => {
	it("is the kubernetes_version default in the hetzner template", () => {
		// The manifest is generated from this file; the Go copy is held to it by
		// TestHetznerKubernetesPinMatchesTemplate. Reading the template here closes the triangle.
		const tf = readFileSync(
			resolve(__dirname, "../../../../../infra/templates/project/hetzner/variables.tf"),
			"utf8",
		);
		const m = /variable "kubernetes_version" \{[^}]*?default\s*=\s*"([^"]+)"/.exec(tf);
		expect(m, "kubernetes_version default not found in variables.tf").not.toBeNull();
		expect(HETZNER_K8S_VERSION).toBe(m?.[1]);
	});

	it("derives the minor", () => {
		expect(k8sMinor("1.35.6")).toBe("1.35");
		expect(k8sMinor("v1.35.6")).toBe("1.35");
		expect(k8sMinor("1.35")).toBe("1.35");
		expect(HETZNER_K8S_MINOR).toBe(k8sMinor(HETZNER_K8S_VERSION));
	});

	it("calls only a set, different minor a conflict", () => {
		expect(hetznerVersionConflicts(undefined)).toBe(false);
		expect(hetznerVersionConflicts(null)).toBe(false);
		expect(hetznerVersionConflicts("")).toBe(false);
		expect(hetznerVersionConflicts(HETZNER_K8S_MINOR)).toBe(false);
		expect(hetznerVersionConflicts(HETZNER_K8S_VERSION)).toBe(false);
		expect(hetznerVersionConflicts("1.33")).toBe(true);
	});

	it("shows the installed version: the pin on Hetzner, the stored value elsewhere", () => {
		expect(displayedK8sVersion("hetzner", null)).toBe(HETZNER_K8S_VERSION);
		expect(displayedK8sVersion("hetzner", "1.33")).toBe(HETZNER_K8S_VERSION);
		expect(displayedK8sVersion("aws", "1.33")).toBe("1.33");
		expect(displayedK8sVersion("aws", null)).toBeNull();
		expect(displayedK8sVersion(null, "")).toBeNull();
	});
});
