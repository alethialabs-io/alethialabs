// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hook test for useElenchThreads — the Phase-2 thread orchestration. Mocks the four agent
// server actions, the Elench zustand store (a controlled state object per test), and track().
// Asserts: org context lists org-level threads → resumes the latest (or creates when empty);
// PROJECT context now does the SAME (no longer ephemeral), scoped by projectId; and `ready`
// flips true only after the initial list→resume/create settles.

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
	renameThread: vi.fn(),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

// A controlled Elench store: the hook reads open/ctx/threadId/selectThread via selectors, so
// the mock simply applies each selector to a per-test state object.
const selectThread = vi.fn();
const storeState: {
	open: boolean;
	ctx: ElenchCtx;
	threadId: string | null;
	selectThread: (id: string | null) => void;
} = {
	open: true,
	ctx: { kind: "org" },
	threadId: null,
	selectThread,
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

	it("creates a fresh org thread when the list is empty", async () => {
		vi.mocked(listThreads).mockResolvedValue([] as never);
		vi.mocked(createThread).mockResolvedValue({ id: "t-fresh" } as never);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(createThread).toHaveBeenCalledWith(undefined, undefined);
		expect(selectThread).toHaveBeenCalledWith("t-fresh");
		expect(getThread).not.toHaveBeenCalled();
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

	it("creates a project-scoped thread when the project has none", async () => {
		storeState.ctx = { kind: "project", projectId: "proj-1" };
		vi.mocked(listThreads).mockResolvedValue([] as never);
		vi.mocked(createThread).mockResolvedValue({ id: "pt-fresh" } as never);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// createThread carries the projectId so the new thread persists under the project.
		expect(createThread).toHaveBeenCalledWith(undefined, "proj-1");
		expect(selectThread).toHaveBeenCalledWith("pt-fresh");
	});
});

describe("useElenchThreads — ready gating", () => {
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
