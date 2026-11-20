// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6836 — what a board starts from: reading `?seed=` against the clouds the SERVER offers, and
// turning a template into design changes on the real document store. No component here; the guide
// and the seed's application on a mounted board are board-guide.test.tsx.

import { beforeEach, describe, expect, it } from "vitest";
import {
	applyTemplate,
	lastSeededTemplate,
	planTemplate,
	readSeedParam,
	seedRefusalSentence,
	templateClouds,
} from "@/components/design-project/canvas/empty/seed";
import { formToGraph } from "@/components/design-project/canvas/graph/form-to-graph";
import { buildDefaultFormValues } from "@/components/design-project/source-project";
import { DEFAULT_INSTANCE_TYPE } from "@/lib/cloud-providers";
import { createBoard, type Board } from "@/lib/canvas/store/board";
import { pendingCount } from "@/lib/canvas/store/document-store";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import type { HandoffRefusal } from "@/lib/projects/connected-account";

const SCOPE = "proj-1:env-a";
const OFFERED = ["aws", "gcp", "azure", "hetzner"];
const AWS_IDENTITY = { id: "ident-aws", name: "prod", displayId: "1111", provider: "aws" };

/** A URL carrying `seed` (and nothing else), as the board's reader sees it. */
function url(seed: string | null) {
	return new URLSearchParams(seed === null ? "" : `seed=${seed}`);
}

/** A board holding a new project's design: a cluster and a network, nothing drawn. */
function boardWith(options: { bound: boolean }): Board {
	const base = buildDefaultFormValues();
	const form = options.bound
		? { ...base, project: { ...base.project, cloud_identity_id: AWS_IDENTITY.id } }
		: base;
	const board = createBoard();
	board.reseed(formToGraph(form, [AWS_IDENTITY]), { scope: SCOPE, revision: "r1" });
	return board;
}

/** The cluster's machine types as the draft holds them. */
function machineTypes(board: Board): unknown {
	const cluster = board.document.getState().designNodes.find((n) => n.data.kind === "cluster");
	return cluster?.data.kind === "cluster" ? cluster.data.config.instance_types : undefined;
}

beforeEach(() => {
	sessionStorage.clear();
});

describe("readSeedParam — the seed in the URL, checked against the offered clouds", () => {
	it("reads no seed from a URL without one", () => {
		expect(readSeedParam(url(null), OFFERED)).toEqual({ status: "none" });
	});

	it("reads each kind of seed, keeping its URL form as its identity", () => {
		expect(readSeedParam(url("v1.blank"), OFFERED)).toEqual({
			status: "ready",
			wire: "v1.blank",
			seed: { kind: "blank" },
		});
		expect(readSeedParam(url("v1.template.standard.hetzner"), OFFERED)).toEqual({
			status: "ready",
			wire: "v1.template.standard.hetzner",
			seed: { kind: "template", templateId: "standard", provider: "hetzner" },
		});
		expect(readSeedParam(url("v1.byo.iac"), OFFERED)).toMatchObject({
			status: "ready",
			seed: { kind: "byo", attach: "iac" },
		});
		expect(readSeedParam(url("v1.proposal.abc-123"), OFFERED)).toMatchObject({
			status: "ready",
			seed: { kind: "proposal", proposalId: "abc-123" },
		});
	});

	it("refuses a seed with the contract's reason", () => {
		expect(readSeedParam(url("nonsense"), OFFERED)).toEqual({ status: "refused", reason: "malformed" });
		expect(readSeedParam(url("v2.blank"), OFFERED)).toEqual({ status: "refused", reason: "version" });
		expect(readSeedParam(url("v1.template.standard.alibaba"), OFFERED)).toEqual({
			status: "refused",
			reason: "cloud-not-offered",
		});
	});

	it("checks a template's cloud against the list it is GIVEN, not the build-time one", () => {
		// The server offers one cloud here: a seed for another is refused although the build offers it.
		expect(readSeedParam(url("v1.template.standard.gcp"), ["aws"])).toEqual({
			status: "refused",
			reason: "cloud-not-offered",
		});
		// And an operator who re-enabled a hidden cloud gets its seed applied.
		expect(readSeedParam(url("v1.template.standard.alibaba"), [...OFFERED, "alibaba"])).toMatchObject({
			status: "ready",
		});
	});

	it("says each refusal in a sentence that names no code", () => {
		const reasons: HandoffRefusal[] = ["malformed", "version", "cloud-not-offered"];
		const sentences = reasons.map(seedRefusalSentence);
		expect(new Set(sentences).size).toBe(3);
		expect(sentences.filter((s) => /malformed|cloud-not-offered|v1/.test(s))).toEqual([]);
	});
});

describe("templateClouds — the clouds a template can be sized for", () => {
	it("keeps the offered clouds a cluster can run on, in the server's order", () => {
		expect(templateClouds(["hetzner", "cloudflare", "aws"])).toEqual(["hetzner", "aws"]);
	});
});

describe("applyTemplate — a template as design changes", () => {
	it("sizes the cluster for the named cloud when the project has none, as pending changes", () => {
		const board = boardWith({ bound: false });
		const document = board.document;
		const pendingBefore = pendingCount(document.getState());

		document.getState().transact("template", () => {
			applyTemplate(document, "standard", "hetzner", null);
		});

		expect(machineTypes(board)).toEqual([DEFAULT_INSTANCE_TYPE.hetzner]);
		expect(pendingCount(document.getState())).toBeGreaterThan(pendingBefore);
		// The project root now says which cloud the draft is sized for.
		const root = document.getState().designNodes.find((n) => n.id === PROJECT_NODE_ID);
		expect(root?.data.provider).toBe("hetzner");
	});

	it("is ONE undo step that restores the board as it was", () => {
		const board = boardWith({ bound: false });
		const document = board.document;
		const before = document.getState().designNodes;
		const pendingBefore = pendingCount(document.getState());

		document.getState().transact("template", () => {
			applyTemplate(document, "standard", "hetzner", null);
		});
		expect(document.getState().history.past).toHaveLength(1);

		expect(document.getState().undo()).toBe(true);
		expect(document.getState().designNodes).toEqual(before);
		expect(pendingCount(document.getState())).toBe(pendingBefore);
		expect(document.getState().history.past).toHaveLength(0);
	});

	it("sizes for the project's own cloud, whatever cloud the seed named", () => {
		const board = boardWith({ bound: true });
		const plan = applyTemplate(board.document, "standard", "hetzner", "aws");
		expect(plan.provider).toBe("aws");
		expect(machineTypes(board)).toEqual([DEFAULT_INSTANCE_TYPE.aws]);
	});

	it("plans no change for a cluster that already has the template's settings", () => {
		const board = boardWith({ bound: true });
		const plan = planTemplate(board.document.getState().designNodes, "standard", "aws", "aws");
		expect(plan).toMatchObject({ changes: false, stampsProject: false, patch: {} });
	});

	it("keeps a provider setting the template does not name", () => {
		const board = boardWith({ bound: false });
		applyTemplate(board.document, "standard", "hetzner", null);
		const cluster = board.document.getState().designNodes.find((n) => n.data.kind === "cluster");
		const config = cluster?.data.kind === "cluster" ? cluster.data.config.provider_config : undefined;
		expect(config).toMatchObject({ enable_karpenter: true, enable_cluster_autoscaler: true });
	});
});

describe("lastSeededTemplate — the template a draft was seeded with", () => {
	it("is the latest template among the seeds the draft recorded", () => {
		expect(lastSeededTemplate([])).toBeNull();
		expect(lastSeededTemplate(["v1.blank", "v1.byo.chart"])).toBeNull();
		expect(
			lastSeededTemplate(["v1.template.standard.aws", "v1.blank", "v1.template.ai.hetzner"]),
		).toEqual({ templateId: "ai", provider: "hetzner" });
	});
});
