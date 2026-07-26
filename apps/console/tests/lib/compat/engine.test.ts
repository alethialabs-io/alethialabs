// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Parity + honesty test for the TS compat engine (apps/console/lib/compat). The
// TS and Go engines MUST agree: the same subject → the same verdict + control
// statuses (the contract-lock discipline — a shared-model change must red both
// sides). The cases here mirror packages/core/compat/compat_test.go 1:1.

import { describe, expect, it } from "vitest";
import { evaluate, isBlocking, unwaived } from "@/lib/compat";

/** Finds a control by id or throws (keeps assertions readable). */
function control(report: ReturnType<typeof evaluate>, id: string) {
	const c = report.controls.find((x) => x.id === id);
	if (!c) throw new Error(`control ${id} not found`);
	return c;
}

describe("compat engine", () => {
	it("catches the #1165 ArgoCD-2.11-on-1.35 regression (fail + blocking)", () => {
		const bad = evaluate({
			providers: ["aws"],
			k8sVersion: "1.35",
			components: [{ id: "argocd", version: "7.1.3" }],
		});
		expect(control(bad, "COMPAT-COMPONENT-ARGOCD").status).toBe("fail");
		expect(bad.verdict).toBe("fail");
		expect(isBlocking(bad)).toBe(true);
		expect(control(bad, "COMPAT-COMPONENT-ARGOCD").findings?.length).toBeGreaterThan(0);
	});

	it("passes ArgoCD 8.6.4 on 1.35", () => {
		const good = evaluate({
			providers: ["aws"],
			k8sVersion: "1.35",
			components: [{ id: "argocd", version: "8.6.4" }],
		});
		expect(control(good, "COMPAT-COMPONENT-ARGOCD").status).toBe("pass");
	});

	it("is honest about an add-on with no recorded window (not_evaluable, never a pass)", () => {
		const rep = evaluate({
			providers: ["aws"],
			k8sVersion: "1.35",
			addons: [{ id: "falco", version: "4.9.0" }],
		});
		const ctrl = control(rep, "COMPAT-ADDON-FALCO");
		expect(ctrl.status).toBe("not_evaluable");
		expect(ctrl.coverage).toBeTruthy();
		expect(rep.verdict).toBe("not_evaluable");
	});

	it("fails an unsupported K8s minor on a cloud, passes a supported one", () => {
		const fail = evaluate({ providers: ["hetzner"], k8sVersion: "1.34" });
		expect(control(fail, "COMPAT-K8S-CLOUD-HETZNER").status).toBe("fail");
		const pass = evaluate({ providers: ["aws"], k8sVersion: "1.34" });
		expect(control(pass, "COMPAT-K8S-CLOUD-AWS").status).toBe("pass");
	});

	it("threads the override machinery (unwaived)", () => {
		const rep = evaluate({
			providers: ["aws"],
			k8sVersion: "1.35",
			components: [{ id: "argocd", version: "7.1.3" }],
		});
		expect(unwaived(rep, null)).toEqual(["COMPAT-COMPONENT-ARGOCD"]);
		expect(
			unwaived(rep, {
				controls: ["COMPAT-COMPONENT-ARGOCD"],
				expiry: new Date(Date.now() + 3_600_000).toISOString(),
			}),
		).toEqual([]);
	});

	it("rolls an empty subject up to not_evaluable, never a pass", () => {
		expect(evaluate({}).verdict).toBe("not_evaluable");
	});
});
