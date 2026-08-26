// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2837: Talos enforces PodSecurity `baseline` on every namespace but kube-system, and baseline
// forbids privileged containers, host namespaces and hostPath volumes. A chart needing any of those
// has its DaemonSet ADMITTED and its pods REJECTED — zero pods, Progressing forever, and nothing in
// the Application saying why. falco and kube-prometheus-stack's node-exporter both hit it.
//
// These tests pin the DECLARATION. The rendering half — that the level becomes
// `syncPolicy.managedNamespaceMetadata.labels` on that add-on's own namespace — is asserted in
// packages/core/argocd/addon_podsecurity_test.go.

import { describe, expect, it } from "vitest";

import { ADDON_CATALOG, resolveAddOnInstall } from "@/lib/addons/catalog";
import { ADDON_POD_SECURITY_LEVELS } from "@/lib/addons/types";

/** Add-ons that genuinely need host access, and why. Changing this list is a security decision. */
const NEEDS_HOST_ACCESS = [
	// 10 hostPath mounts and `privileged: true` — it reads syscalls off the node.
	"falco",
	// The bundled prometheus-node-exporter DaemonSet: hostNetwork, hostPID and three hostPaths.
	"kube-prometheus-stack",
] as const;

describe("add-on Pod Security declarations (#2837)", () => {
	it.each(NEEDS_HOST_ACCESS)(
		"%s declares privileged, because baseline would reject its pods",
		(id) => {
			const def = ADDON_CATALOG.find((a) => a.id === id);
			expect(def, `${id} is not in the catalog`).toBeDefined();
			expect(def?.podSecurity).toBe("privileged");
		},
	);

	it("every OTHER add-on declares nothing, leaving the cluster default in force", () => {
		// The invariant that makes this fix a narrowing rather than a widening. Labelling namespaces
		// `privileged` by default — or letting the field spread by copy-paste — would silently
		// disable admission across the cluster, which is the opposite of the intent.
		const unexpected = ADDON_CATALOG.filter(
			(a) =>
				a.podSecurity !== undefined &&
				!NEEDS_HOST_ACCESS.includes(a.id as (typeof NEEDS_HOST_ACCESS)[number]),
		).map((a) => `${a.id}=${a.podSecurity}`);
		expect(unexpected).toEqual([]);
	});

	it("no add-on declares a level outside the three upstream values", () => {
		// The renderer ignores an unknown level rather than rendering it, because the API server
		// rejects an unknown enforce label and that failure would take the Application's sync down.
		// Catching a typo here means never relying on that fallback.
		for (const a of ADDON_CATALOG) {
			if (a.podSecurity === undefined) continue;
			expect(ADDON_POD_SECURITY_LEVELS).toContain(a.podSecurity);
		}
	});

	it("the level survives into the resolved install spec the runner receives", () => {
		// The declaration is worthless if resolveAddOnInstall drops it: the runner renders the
		// Application from this spec, and the fixture the e2e harness seeds is this spec.
		const falco = resolveAddOnInstall({ addon_id: "falco", mode: "managed" });
		expect(falco?.podSecurity).toBe("privileged");

		// And an add-on that declares none must not acquire one on the way through.
		const reloader = resolveAddOnInstall({ addon_id: "reloader", mode: "managed" });
		expect(reloader?.podSecurity).toBeUndefined();
	});
});
