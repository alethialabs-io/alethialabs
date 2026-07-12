// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hook test for useElenchThreads — the lazy thread orchestration. Mocks the agent server
// actions, the Elench zustand store (a controlled state object per test), and track().
// Asserts: org context lists org-level threads → resumes the latest; an EMPTY list resolves
// to an ephemeral conversation (nothing persisted — no createThread); PROJECT context does
// the SAME, scoped by projectId; and `ready` flips true only after the initial list→resume
// settles.

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createThread,
	getThread,
	listThreads,
} from "@/app/server/actions/agent";
import type { ElenchCtx } from "@/lib/stores/use-elench-store";
import { useElenchThreads } from "@/components/agent/elench/use-elench-threads";

vi.mock("@/app/server/actions/agent", () => ({
	listThreads: vi.fn(),
	getThread: vi.fn(),
	createThread: vi.fn(),
	deleteThread: vi.fn(),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

// A controlled Elench store: the hook reads open/ctx/threadId + the selectThread/attachThread/
// newChat actions via selectors, so the mock applies each selector to a per-test state object.
const selectThread = vi.fn();
const attachThread = vi.fn();
const newChat = vi.fn();
const storeState: {
	open: boolean;
	ctx: ElenchCtx;
	threadId: string | null;
	selectThread: (id: string | null) => void;
	attachThread: (id: string) => void;
	newChat: () => void;
} = {
	open: true,
	ctx: { kind: "org" },
	threadId: null,
	selectThread,
	attachThread,
	newChat,
};
vi.mock("@/lib/stores/use-elench-store", () => ({
	useElenchStore: (selector: (s: typeof storeState) => unknown) =>
		selector(storeState),
}));

beforeEach(() => {
	vi.clearAllMocks();
	storeState.open = true;
	storeState.ctx = { kind: "org" };
	storeState.threadId = null;
});

describe("useElenchThreads — org context", () => {
	it("lists org-level threads (project_id IS NULL) and resumes the most recent", async () => {
		vi.mocked(listThreads).mockResolvedValue([
			{ id: "t-newest" },
			{ id: "t-older" },
		] as never);
		vi.mocked(getThread).mockResolvedValue({
			id: "t-newest",
			messages: [{ id: "m1", role: "user", parts: [] }],
		} as never);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// Org-level listing passes no projectId.
		expect(listThreads).toHaveBeenCalledWith(undefined);
		// Resumes the latest (list[0]) — loads its transcript, then selects it. Never creates.
		expect(getThread).toHaveBeenCalledWith("t-newest");
		expect(selectThread).toHaveBeenCalledWith("t-newest");
		expect(createThread).not.toHaveBeenCalled();
		expect(result.current.initialMessages).toHaveLength(1);
	});

	it("resolves to an ephemeral conversation when the list is empty (persists nothing)", async () => {
		vi.mocked(listThreads).mockResolvedValue([] as never);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// Nothing is created until the first send — no empty thread litters the rail.
		expect(createThread).not.toHaveBeenCalled();
		expect(selectThread).not.toHaveBeenCalled();
		expect(getThread).not.toHaveBeenCalled();
		expect(result.current.activeId).toBeNull();
		expect(result.current.initialMessages).toHaveLength(0);
	});
});

describe("useElenchThreads — project context (Phase-2 un-gating)", () => {
	it("lists + resumes threads scoped to the project id (same as org, not ephemeral)", async () => {
		storeState.ctx = { kind: "project", projectId: "proj-1" };
		vi.mocked(listThreads).mockResolvedValue([{ id: "pt-newest" }] as never);
		vi.mocked(getThread).mockResolvedValue({
			id: "pt-newest",
			messages: [],
		} as never);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// Scoped by the project id — project conversations persist and resume.
		expect(listThreads).toHaveBeenCalledWith("proj-1");
		expect(getThread).toHaveBeenCalledWith("pt-newest");
		expect(selectThread).toHaveBeenCalledWith("pt-newest");
		expect(createThread).not.toHaveBeenCalled();
	});

	it("resolves to an ephemeral conversation when the project has no threads", async () => {
		storeState.ctx = { kind: "project", projectId: "proj-1" };
		vi.mocked(listThreads).mockResolvedValue([] as never);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// A project thread is created lazily on the first send (via startThread), not on open.
		expect(createThread).not.toHaveBeenCalled();
		expect(selectThread).not.toHaveBeenCalled();
		expect(result.current.activeId).toBeNull();
	});

	it("lazily creates + attaches a project thread on the first send (startThread)", async () => {
		storeState.ctx = { kind: "project", projectId: "proj-1" };
		vi.mocked(listThreads).mockResolvedValue([] as never);
		vi.mocked(createThread).mockResolvedValue({ id: "pt-fresh" } as never);

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(result.current.ready).toBe(true));

		await result.current.startThread("scale my cluster");
		// createThread carries the first message (title) + projectId; the id attaches WITHOUT
		// bumping the lineage so the in-flight send is not recreated.
		expect(createThread).toHaveBeenCalledWith("scale my cluster", "proj-1");
		expect(attachThread).toHaveBeenCalledWith("pt-fresh");
		expect(selectThread).not.toHaveBeenCalled();
	});
});

describe("useElenchThreads — ready gating", () => {
	// NOTE: the "resume wedges the surface on its loading skeleton" regression (resuming
	// flipped the store's threadId → the initial-load effect re-ran → its cleanup cancelled
	// the in-flight resolve → `ready` never landed) is guarded by the e2e suite
	// (e2e/elench-ai.spec.ts), not here: it needs React's real render flush to interleave
	// with the resolve, which this hook double can't reproduce faithfully.
	it("keeps ready=false until the initial resolve settles", async () => {
		let resolveList: (v: unknown) => void = () => {};
		vi.mocked(listThreads).mockImplementation(
			() => new Promise((res) => (resolveList = res)) as never,
		);

		const { result } = renderHook(() => useElenchThreads());

		// The list promise is still pending → not ready yet.
		expect(result.current.ready).toBe(false);

		vi.mocked(getThread).mockResolvedValue({ id: "t-1", messages: [] } as never);
		resolveList([{ id: "t-1" }]);

		await waitFor(() => expect(result.current.ready).toBe(true));
	});

	it("does not run the initial load while the surface is closed", async () => {
		storeState.open = false;
		const { result } = renderHook(() => useElenchThreads());
		// Give any (incorrectly-scheduled) effect a tick to run.
		await Promise.resolve();
		expect(listThreads).not.toHaveBeenCalled();
		expect(result.current.ready).toBe(false);
	});
});
