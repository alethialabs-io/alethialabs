// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The workspace switcher is what makes the Claude-Projects model navigable: stepping into a
// project must flip `ctx` (which re-scopes the thread list, the Knowledge row and the memory
// namespace) AND start a fresh conversation — an org chat's transcript must never be carried
// into a project workspace, and vice-versa.

import { beforeEach, describe, expect, it } from "vitest";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { memoryNamespace } from "@/lib/agent/memory-path";

const ORG = "11111111-1111-1111-1111-111111111111";
const PROJECT = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
	useElenchStore.setState({
		open: true,
		view: "modal",
		ctx: { kind: "org" },
		threadId: "org-thread",
		epoch: 0,
		mainView: "chat",
	});
});

describe("workspace switching (ctx)", () => {
	it("stepping into a project re-scopes ctx and starts a fresh conversation", () => {
		useElenchStore.getState().openModal({ kind: "project", projectId: PROJECT });
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({ kind: "project", projectId: PROJECT });
		// The org thread must NOT follow us into the project workspace.
		expect(s.threadId).toBeNull();
		expect(s.epoch).toBe(1);
	});

	it("stepping back out to the general assistant re-scopes to org and resets again", () => {
		useElenchStore.getState().openModal({ kind: "project", projectId: PROJECT });
		useElenchStore.setState({ threadId: "project-thread" });
		useElenchStore.getState().openModal({ kind: "org" });
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({ kind: "org" });
		expect(s.threadId).toBeNull();
	});

	it("re-selecting the SAME workspace keeps the conversation (not a reset)", () => {
		useElenchStore.getState().openModal({ kind: "project", projectId: PROJECT });
		useElenchStore.setState({ threadId: "project-thread" });
		const before = useElenchStore.getState().epoch;
		useElenchStore.getState().openModal({ kind: "project", projectId: PROJECT });
		const s = useElenchStore.getState();
		expect(s.threadId).toBe("project-thread");
		expect(s.epoch).toBe(before);
	});
});

describe("scope isolation", () => {
	it("each workspace addresses its own memory namespace (Claude: memory per project)", () => {
		expect(memoryNamespace(ORG)).toBe(`org/${ORG}`);
		expect(memoryNamespace(ORG, PROJECT)).toBe(`org/${ORG}/project/${PROJECT}`);
		// A project's namespace is strictly nested under the org's — never the same bucket.
		expect(memoryNamespace(ORG, PROJECT)).not.toBe(memoryNamespace(ORG));
	});
});
