// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Pure zod contract for AI canvas proposals (lib/ai/proposal.ts). No boundary to mock —
// exercise the discriminated-union action schema, the proposal wrapper, and the
// propose_changes tool input (min(1) actions, id stripped) across accept + reject cases.

import { describe, expect, it } from "vitest";

import {
	aiActionSchema,
	aiProposalSchema,
	proposeChangesInputSchema,
} from "@/lib/ai/proposal";

describe("aiActionSchema — add_node", () => {
	it("accepts an add_node with a valid nodeKind and optional fields omitted", () => {
		const res = aiActionSchema.safeParse({ kind: "add_node", nodeKind: "database" });
		expect(res.success).toBe(true);
		if (res.success) {
			expect(res.data.kind).toBe("add_node");
			// optional fields are absent, not defaulted
			expect("config" in res.data).toBe(false);
		}
	});

	it("accepts add_node carrying config + a null cloudIdentityId", () => {
		const res = aiActionSchema.safeParse({
			kind: "add_node",
			nodeKind: "cluster",
			config: { region: "eu-central-1" },
			cloudIdentityId: null,
		});
		expect(res.success).toBe(true);
		if (res.success && res.data.kind === "add_node") {
			expect(res.data.config).toEqual({ region: "eu-central-1" });
			expect(res.data.cloudIdentityId).toBeNull();
		}
	});

	it("rejects add_node with a nodeKind outside the allowed enum", () => {
		const res = aiActionSchema.safeParse({ kind: "add_node", nodeKind: "loadbalancer" });
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes("nodeKind"))).toBe(true);
		}
	});

	it("rejects add_node missing the required nodeKind", () => {
		expect(aiActionSchema.safeParse({ kind: "add_node" }).success).toBe(false);
	});
});

describe("aiActionSchema — set_identity / update_config", () => {
	it("accepts set_identity with a string cloudIdentityId", () => {
		const res = aiActionSchema.safeParse({
			kind: "set_identity",
			nodeId: "node-1",
			cloudIdentityId: "ci-abc",
		});
		expect(res.success).toBe(true);
		if (res.success && res.data.kind === "set_identity") {
			expect(res.data.nodeId).toBe("node-1");
			expect(res.data.cloudIdentityId).toBe("ci-abc");
		}
	});

	it("rejects set_identity when cloudIdentityId is omitted (it is required, nullable not optional)", () => {
		const res = aiActionSchema.safeParse({ kind: "set_identity", nodeId: "node-1" });
		expect(res.success).toBe(false);
	});

	it("accepts update_config with a patch record", () => {
		const res = aiActionSchema.safeParse({
			kind: "update_config",
			nodeId: "node-2",
			patch: { size: "large", count: 3 },
		});
		expect(res.success).toBe(true);
		if (res.success && res.data.kind === "update_config") {
			expect(res.data.patch).toEqual({ size: "large", count: 3 });
		}
	});

	it("rejects update_config without a patch (patch is required, not optional)", () => {
		expect(
			aiActionSchema.safeParse({ kind: "update_config", nodeId: "node-2" }).success,
		).toBe(false);
	});

	it("rejects an unknown discriminator kind", () => {
		const res = aiActionSchema.safeParse({ kind: "delete_node", nodeId: "node-3" });
		expect(res.success).toBe(false);
	});
});

describe("aiProposalSchema", () => {
	it("accepts a full proposal with id, label and a typed action list", () => {
		const res = aiProposalSchema.safeParse({
			id: "prop-1",
			label: "Add a Postgres database on AWS",
			actions: [{ kind: "add_node", nodeKind: "database" }],
		});
		expect(res.success).toBe(true);
		if (res.success) {
			expect(res.data.id).toBe("prop-1");
			expect(res.data.actions).toHaveLength(1);
		}
	});

	it("accepts a proposal with an empty actions array (no min on the wrapper)", () => {
		const res = aiProposalSchema.safeParse({ id: "p", label: "noop", actions: [] });
		expect(res.success).toBe(true);
	});

	it("rejects a proposal missing the id assigned server-side", () => {
		const res = aiProposalSchema.safeParse({
			label: "x",
			actions: [{ kind: "add_node", nodeKind: "dns" }],
		});
		expect(res.success).toBe(false);
	});

	it("rejects a proposal whose action list contains an invalid action", () => {
		const res = aiProposalSchema.safeParse({
			id: "p",
			label: "bad",
			actions: [{ kind: "add_node", nodeKind: "not-real" }],
		});
		expect(res.success).toBe(false);
	});
});

describe("proposeChangesInputSchema", () => {
	it("accepts model input with label + at least one action and has no id field", () => {
		const res = proposeChangesInputSchema.safeParse({
			label: "Add a cache",
			actions: [{ kind: "add_node", nodeKind: "cache" }],
		});
		expect(res.success).toBe(true);
		if (res.success) {
			// id is assigned server-side, so it must not be part of the tool input
			expect("id" in res.data).toBe(false);
			expect(res.data.label).toBe("Add a cache");
		}
	});

	it("rejects an empty actions array (min(1))", () => {
		const res = proposeChangesInputSchema.safeParse({ label: "empty", actions: [] });
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error.issues.some((i) => i.path.includes("actions"))).toBe(true);
		}
	});

	it("rejects input missing the label", () => {
		expect(
			proposeChangesInputSchema.safeParse({
				actions: [{ kind: "add_node", nodeKind: "queue" }],
			}).success,
		).toBe(false);
	});
});
