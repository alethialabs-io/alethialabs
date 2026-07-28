// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment compat alert (#1221). What's pinned here is mostly what it REFUSES to say.
//
// The subject it builds in the browser is a subset of the one the config-time resolver builds
// server-side (which also sees Hetzner in-cluster data services and BYO charts), and there is no
// stored verdict to read instead. So "everything is compatible" is a claim this component cannot
// back — and a banner that fires on `not_evaluable` would be permanently on, because 9 of the 19
// catalogued add-ons have no recorded window at all.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CompatAlert } from "@/components/design-project/canvas/inspector/compat-alert";

describe("CompatAlert", () => {
	it("names the add-on and the requirement when the cluster is too old", () => {
		// kyverno is 1.25+ in the matrix.
		render(<CompatAlert provider="aws" k8sVersion="1.24" addonIds={["kyverno"]} />);
		expect(screen.getByText(/won't work on this Kubernetes version/i)).toBeInTheDocument();
		expect(screen.getByText(/requires Kubernetes 1\.25\+/i)).toBeInTheDocument();
		expect(screen.getByText(/cluster is 1\.24/i)).toBeInTheDocument();
	});

	it("renders NOTHING when every add-on fits — no green all-clear", () => {
		const { container } = render(
			<CompatAlert provider="aws" k8sVersion="1.35" addonIds={["kyverno"]} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders NOTHING for unknowns alone — a permanent banner is furniture", () => {
		// loki + falco have no recorded window. This is the steady state for most environments, so
		// firing on it would leave the alert always on and therefore ignored. The per-add-on
		// "Unverified" markers (#1222) carry that signal where it is actionable.
		const { container } = render(
			<CompatAlert provider="aws" k8sVersion="1.35" addonIds={["loki", "falco"]} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("counts the unknowns as a footnote INSIDE a real warning", () => {
		render(
			<CompatAlert provider="aws" k8sVersion="1.24" addonIds={["kyverno", "loki", "falco"]} />,
		);
		expect(screen.getByText(/no recorded compatibility window/i)).toBeInTheDocument();
	});

	it("catches a Kubernetes version the cloud itself doesn't offer", () => {
		// Unlike the add-on set, the cloud↔k8s control is complete — the matrix lists every
		// supported minor per cloud, so this one CAN be judged fully.
		render(<CompatAlert provider="aws" k8sVersion="1.20" addonIds={[]} />);
		expect(screen.getByText(/won't work on this Kubernetes version/i)).toBeInTheDocument();
	});

	it("never claims completeness, and never claims authority", () => {
		render(<CompatAlert provider="aws" k8sVersion="1.24" addonIds={["kyverno"]} />);
		// It says what it checked …
		expect(screen.getByText(/marketplace add-ons/i)).toBeInTheDocument();
		// … and defers the decision to the gate that actually blocks.
		expect(screen.getByText(/apply gate is the authority/i)).toBeInTheDocument();
	});

	it("is silent with no cluster version rather than guessing", () => {
		const { container } = render(
			<CompatAlert provider="aws" k8sVersion={undefined} addonIds={["kyverno"]} />,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
