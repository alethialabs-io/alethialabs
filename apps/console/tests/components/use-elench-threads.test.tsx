// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hook test for useElenchThreads — the lazy thread orchestration. Mocks the agent server
// actions and track(); drives the REAL Elench zustand store (reset per test), because the
// defect class this file guards (#5677) is an interaction between the hook's late resume and
// state the user changed in the store meanwhile — a store double cannot hold that state.
// Asserts: org context lists org-level threads → resumes the latest; an EMPTY list resolves
// to an ephemeral conversation (nothing persisted — no createThread); PROJECT context does
// the SAME, scoped by projectId; `ready` flips true only after the initial list→resume
// settles; the late resume never overrides what the user did while it was in flight; and a
// context switch or close mid-load neither wedges the skeleton nor writes the stale resume (#5680).

import { act, renderHook, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createThread,
	getThread,
	type LoadedThread,
	listThreads,
} from "@/app/server/actions/agent";
import type { AgentThread } from "@/lib/db/schema";
import { type ElenchCtxRequest, useElenchStore } from "@/lib/stores/use-elench-store";
import { useElenchThreads } from "@/components/agent/elench/use-elench-threads";

vi.mock("@/app/server/actions/agent", () => ({
	listThreads: vi.fn(),
	getThread: vi.fn(),
	createThread: vi.fn(),
	deleteThread: vi.fn(),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

/** A persisted thread row with the given id (and transcript), every other column filled, as getThread loads it. */
function thread(id: string, messages: UIMessage[] = []): LoadedThread {
	const at = new Date("2026-10-08T00:00:00Z");
	return {
		id,
		user_id: "u-1",
		org_id: "o-1",
		project_id: null,
		title: id,
		status: "active",
		kind: "agent",
		messages,
		billing_org_id: null,
		revision: 1,
		created_at: at,
		updated_at: at,
		inFlight: null,
	};
}

/** A promise plus its resolver, so a test can hold a server round trip open. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve: (v: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	useElenchStore.setState({
		open: true,
		ctx: { kind: "org" },
		threadId: null,
		epoch: 0,
		mainView: "chat",
	});
});

describe("useElenchThreads — org context", () => {
	it("lists org-level threads (project_id IS NULL) and resumes the most recent", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-newest"), thread("t-older")]);
		vi.mocked(getThread).mockResolvedValue(
			thread("t-newest", [{ id: "m1", role: "user", parts: [] }]),
		);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// Org-level listing passes no projectId.
		expect(listThreads).toHaveBeenCalledWith(undefined);
		// Resumes the latest (list[0]) — loads its transcript, then points at it with a lineage
		// bump. Never creates.
		expect(getThread).toHaveBeenCalledWith("t-newest");
		expect(useElenchStore.getState().threadId).toBe("t-newest");
		expect(useElenchStore.getState().epoch).toBe(1);
		expect(createThread).not.toHaveBeenCalled();
		expect(result.current.initialMessages).toHaveLength(1);
	});

	it("resolves to an ephemeral conversation when the list is empty (persists nothing)", async () => {
		vi.mocked(listThreads).mockResolvedValue([]);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// Nothing is created until the first send — no empty thread litters the rail.
		expect(createThread).not.toHaveBeenCalled();
		expect(getThread).not.toHaveBeenCalled();
		expect(useElenchStore.getState().epoch).toBe(0);
		expect(result.current.activeId).toBeNull();
		expect(result.current.initialMessages).toHaveLength(0);
	});
});

describe("useElenchThreads — project context (Phase-2 un-gating)", () => {
	it("lists + resumes threads scoped to the project id (same as org, not ephemeral)", async () => {
		useElenchStore.setState({
			ctx: { kind: "project", projectId: "proj-1", environmentId: null },
		});
		vi.mocked(listThreads).mockResolvedValue([thread("pt-newest")]);
		vi.mocked(getThread).mockResolvedValue(thread("pt-newest"));

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// Scoped by the project id — project conversations persist and resume.
		expect(listThreads).toHaveBeenCalledWith("proj-1");
		expect(getThread).toHaveBeenCalledWith("pt-newest");
		expect(useElenchStore.getState().threadId).toBe("pt-newest");
		expect(createThread).not.toHaveBeenCalled();
	});

	it("resolves to an ephemeral conversation when the project has no threads", async () => {
		useElenchStore.setState({
			ctx: { kind: "project", projectId: "proj-1", environmentId: null },
		});
		vi.mocked(listThreads).mockResolvedValue([]);

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		// A project thread is created lazily on the first send (via startThread), not on open.
		expect(createThread).not.toHaveBeenCalled();
		expect(useElenchStore.getState().epoch).toBe(0);
		expect(result.current.activeId).toBeNull();
	});

	it("lazily creates + attaches a project thread on the first send (startThread)", async () => {
		useElenchStore.setState({
			ctx: { kind: "project", projectId: "proj-1", environmentId: null },
		});
		vi.mocked(listThreads).mockResolvedValue([]);
		vi.mocked(createThread).mockResolvedValue(thread("pt-fresh"));

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(result.current.ready).toBe(true));

		const turn = { id: "msg-1", text: "scale my cluster" };
		await act(() => result.current.startThread("scale my cluster", turn));
		// createThread carries the title + projectId + the user turn to store with the row; the
		// id attaches WITHOUT bumping the lineage so the in-flight send is not recreated.
		expect(createThread).toHaveBeenCalledWith("scale my cluster", "proj-1", turn);
		expect(useElenchStore.getState().threadId).toBe("pt-fresh");
		expect(useElenchStore.getState().epoch).toBe(0);
	});
});

describe("useElenchThreads — ready gating", () => {
	// NOTE: the "resume wedges the surface on its loading skeleton" regression (resuming
	// flipped the store's threadId → the initial-load effect re-ran → its cleanup cancelled
	// the in-flight resolve → `ready` never landed) is guarded by the e2e suite
	// (e2e/elench-ai.spec.ts), not here: it needs React's real render flush to interleave
	// with the resolve, which this hook test can't reproduce faithfully.
	it("keeps ready=false until the initial resolve settles", async () => {
		const list = deferred<AgentThread[]>();
		vi.mocked(listThreads).mockReturnValue(list.promise);

		const { result } = renderHook(() => useElenchThreads());

		// The list promise is still pending → not ready yet.
		expect(result.current.ready).toBe(false);

		vi.mocked(getThread).mockResolvedValue(thread("t-1"));
		list.resolve([thread("t-1")]);

		await waitFor(() => expect(result.current.ready).toBe(true));
	});

	it("does not run the initial load while the surface is closed", async () => {
		useElenchStore.setState({ open: false });
		const { result } = renderHook(() => useElenchThreads());
		// Give any (incorrectly-scheduled) effect a tick to run.
		await Promise.resolve();
		expect(listThreads).not.toHaveBeenCalled();
		expect(result.current.ready).toBe(false);
	});
});

// #5677: the rail (Artifacts, Knowledge, the thread list, New chat) is interactive while the
// initial list → getThread round trips are in flight. The resume that lands afterwards must
// not undo what the user did in that window.
describe("useElenchThreads — the late initial resume (#5677)", () => {
	it("leaves the view the user switched to while the transcript was loading", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-newest")]);
		const held = deferred<LoadedThread | null>();
		vi.mocked(getThread).mockReturnValue(held.promise);

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(getThread).toHaveBeenCalledWith("t-newest"));

		// The user clicks Artifacts in the rail before the transcript arrives.
		act(() => useElenchStore.getState().setMainView("artifacts"));
		await act(async () => held.resolve(thread("t-newest")));

		await waitFor(() => expect(result.current.ready).toBe(true));
		// The thread is still resumed (the chat underneath is ready for when they go back)…
		expect(useElenchStore.getState().threadId).toBe("t-newest");
		// …but the gallery they asked for stays on screen.
		expect(useElenchStore.getState().mainView).toBe("artifacts");
	});

	it("stands down when the user picked another thread while the transcript was loading", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-newest"), thread("t-older")]);
		const held = deferred<LoadedThread | null>();
		// The resume's round trip (t-newest) is held; the user's pick (t-older) answers at once.
		vi.mocked(getThread).mockImplementation((id) =>
			id === "t-newest" ? held.promise : Promise.resolve(thread(id)),
		);

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(getThread).toHaveBeenCalledWith("t-newest"));

		// The user opens an older thread from the rail before the resume lands.
		await act(async () => result.current.selectThread("t-older"));
		await waitFor(() => expect(useElenchStore.getState().threadId).toBe("t-older"));
		const afterPick = useElenchStore.getState().epoch;

		await act(async () =>
			held.resolve(thread("t-newest", [{ id: "m1", role: "user", parts: [] }])),
		);
		await waitFor(() => expect(result.current.ready).toBe(true));

		// The late resume of list[0] must not override the user's pick, nor its transcript.
		expect(useElenchStore.getState().threadId).toBe("t-older");
		expect(useElenchStore.getState().epoch).toBe(afterPick);
		expect(result.current.initialMessages).toHaveLength(0);
	});

	it("stands down when the user started a new chat while the transcript was loading", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-newest")]);
		const held = deferred<LoadedThread | null>();
		vi.mocked(getThread).mockReturnValue(held.promise);

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(getThread).toHaveBeenCalledWith("t-newest"));

		act(() => result.current.newChat());
		const afterNewChat = useElenchStore.getState().epoch;
		await act(async () =>
			held.resolve(thread("t-newest", [{ id: "m1", role: "user", parts: [] }])),
		);
		await waitFor(() => expect(result.current.ready).toBe(true));

		// Still the fresh ephemeral conversation: no thread, no lineage bump, no transcript.
		expect(useElenchStore.getState().threadId).toBeNull();
		expect(useElenchStore.getState().epoch).toBe(afterNewChat);
		expect(result.current.initialMessages).toHaveLength(0);
	});

	it("a user-initiated thread pick still returns to the chat", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-newest"), thread("t-older")]);
		vi.mocked(getThread).mockImplementation(async (id) => thread(id));

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(result.current.ready).toBe(true));

		act(() => useElenchStore.getState().setMainView("knowledge"));
		await act(async () => result.current.selectThread("t-older"));

		await waitFor(() => expect(useElenchStore.getState().threadId).toBe("t-older"));
		expect(useElenchStore.getState().mainView).toBe("chat");
	});
});

// The initial resume used to be what put a reopened surface back on the chat. Now that it
// leaves the view alone, opening from closed does it instead — and only from closed.
const OPENERS: ReadonlyArray<"openPanel" | "openModal"> = ["openPanel", "openModal"];

describe("useElenchStore — opening lands on the chat (#5677)", () => {
	it.each(OPENERS)(
		"%s from closed resets the view to the chat",
		(opener) => {
			useElenchStore.setState({ open: false, mainView: "knowledge" });
			useElenchStore.getState()[opener]({ kind: "org" });
			expect(useElenchStore.getState().mainView).toBe("chat");
		},
	);

	it.each(OPENERS)(
		"%s on an already-open surface keeps what it shows",
		(opener) => {
			useElenchStore.setState({ open: true, mainView: "artifacts" });
			useElenchStore.getState()[opener]({ kind: "org" });
			expect(useElenchStore.getState().mainView).toBe("artifacts");
		},
	);
});

// #5680: the assistant can change context while it is open (openPanel/openModal with another
// project, or org ↔ project), and it can close, while the initial load is in flight. A switch
// must load the NEW context the way opening there from closed would; a close must leave the
// store alone.
describe("useElenchThreads — a context switch or close mid-load (#5680)", () => {
	const PROJECT: ElenchCtxRequest = { kind: "project", projectId: "proj-2" };

	it("a switch while the list is loading loads the new context instead of sticking on the skeleton", async () => {
		const orgList = deferred<AgentThread[]>();
		vi.mocked(listThreads).mockImplementation((projectId) =>
			projectId === "proj-2" ? Promise.resolve([thread("pt-1")]) : orgList.promise,
		);
		vi.mocked(getThread).mockImplementation(async (id) => thread(id));

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(listThreads).toHaveBeenCalledWith(undefined));

		act(() => useElenchStore.getState().openPanel(PROJECT));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(listThreads).toHaveBeenCalledWith("proj-2");
		expect(useElenchStore.getState().threadId).toBe("pt-1");
		expect(result.current.threads.map((t) => t.id)).toEqual(["pt-1"]);

		// The org list arriving late changes nothing: its load stood down at the switch.
		await act(async () => orgList.resolve([thread("t-org")]));
		expect(result.current.threads.map((t) => t.id)).toEqual(["pt-1"]);
		expect(useElenchStore.getState().threadId).toBe("pt-1");
	});

	it("a switch while the transcript is loading loads the new context instead of sticking on the skeleton", async () => {
		vi.mocked(listThreads).mockImplementation(async (projectId) =>
			projectId === "proj-2" ? [thread("pt-1")] : [thread("t-org")],
		);
		const held = deferred<LoadedThread | null>();
		vi.mocked(getThread).mockImplementation((id) =>
			id === "t-org" ? held.promise : Promise.resolve(thread(id)),
		);

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(getThread).toHaveBeenCalledWith("t-org"));

		act(() => useElenchStore.getState().openModal(PROJECT));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(useElenchStore.getState().threadId).toBe("pt-1");

		// The org transcript arriving late is not resumed over the project's thread.
		await act(async () =>
			held.resolve(thread("t-org", [{ id: "m1", role: "user", parts: [] }])),
		);
		expect(useElenchStore.getState().threadId).toBe("pt-1");
		expect(result.current.initialMessages).toHaveLength(0);
	});

	it("a switch into a context with no threads lands on an EMPTY conversation, not the old transcript", async () => {
		vi.mocked(listThreads).mockImplementation(async (projectId) =>
			projectId === "proj-2" ? [] : [thread("t-org")],
		);
		vi.mocked(getThread).mockImplementation(async (id) =>
			thread(id, [{ id: "m1", role: "user", parts: [] }]),
		);

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(result.current.initialMessages).toHaveLength(1));

		act(() => useElenchStore.getState().openPanel(PROJECT));
		await waitFor(() => expect(listThreads).toHaveBeenCalledWith("proj-2"));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(useElenchStore.getState().threadId).toBeNull();
		expect(result.current.threads).toHaveLength(0);
		expect(result.current.initialMessages).toHaveLength(0);
	});

	it("a switch after the load shows the skeleton until the new context resolves, then its threads", async () => {
		const projectList = deferred<AgentThread[]>();
		vi.mocked(listThreads).mockImplementation((projectId) =>
			projectId === "proj-2" ? projectList.promise : Promise.resolve([thread("t-org")]),
		);
		vi.mocked(getThread).mockImplementation(async (id) => thread(id));

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(result.current.ready).toBe(true));

		act(() => useElenchStore.getState().openPanel(PROJECT));
		// Exactly as opening there from closed: the skeleton, not the org conversation.
		await waitFor(() => expect(result.current.ready).toBe(false));

		await act(async () => projectList.resolve([thread("pt-1")]));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.threads.map((t) => t.id)).toEqual(["pt-1"]);
		expect(useElenchStore.getState().threadId).toBe("pt-1");
	});

	it("a transcript that arrives after the surface closed writes nothing into the store", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-newest")]);
		const held = deferred<LoadedThread | null>();
		vi.mocked(getThread).mockReturnValue(held.promise);

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(getThread).toHaveBeenCalledWith("t-newest"));

		act(() => useElenchStore.getState().close());
		const atClose = useElenchStore.getState();
		await act(async () =>
			held.resolve(thread("t-newest", [{ id: "m1", role: "user", parts: [] }])),
		);

		expect(useElenchStore.getState().threadId).toBe(atClose.threadId);
		expect(useElenchStore.getState().epoch).toBe(atClose.epoch);
		expect(result.current.initialMessages).toHaveLength(0);
		expect(result.current.ready).toBe(false);
	});
});

// G10 (ADR 0001 slice 10): a rejected list or resume used to leave the body on its skeleton for
// good — the rejection escaped the effect and `ready` never flipped. Both are caught into `loadError`.
describe("useElenchThreads — a load that fails (G10)", () => {
	it("a rejected listThreads resolves with loadError, and retryLoad lists again", async () => {
		vi.mocked(listThreads).mockRejectedValueOnce(new TypeError("Failed to fetch"));
		vi.mocked(listThreads).mockResolvedValueOnce([thread("t-1")]);
		vi.mocked(getThread).mockResolvedValue(thread("t-1"));

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.loadError).toEqual({ step: "list", conversationId: null });
		expect(result.current.threads).toEqual([]);

		act(() => result.current.retryLoad());
		await waitFor(() => expect(useElenchStore.getState().threadId).toBe("t-1"));
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.loadError).toBeNull();
		expect(result.current.threads.map((t) => t.id)).toEqual(["t-1"]);
	});

	it("a rejected resume getThread resolves with loadError and leaves the conversation as it was", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-1")]);
		vi.mocked(getThread).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		const { result } = renderHook(() => useElenchThreads());

		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(result.current.loadError).toEqual({ step: "resume", conversationId: "t-1" });
		// Nothing was resumed: a thread selected with an empty transcript would read as loaded.
		expect(useElenchStore.getState().threadId).toBeNull();
		expect(useElenchStore.getState().epoch).toBe(0);
	});

	it("retryLoad after a failed pick retries THAT conversation, not the open-time resume", async () => {
		vi.mocked(listThreads).mockResolvedValue([thread("t-1"), thread("t-2"), thread("t-3")]);
		vi.mocked(getThread).mockImplementation(async (id: string) => thread(id));

		const { result } = renderHook(() => useElenchThreads());
		await waitFor(() => expect(result.current.ready).toBe(true));
		expect(useElenchStore.getState().threadId).toBe("t-1");

		act(() => result.current.selectThread("t-3"));
		await waitFor(() => expect(useElenchStore.getState().threadId).toBe("t-3"));

		vi.mocked(getThread).mockRejectedValueOnce(new TypeError("Failed to fetch"));
		act(() => result.current.selectThread("t-2"));
		await waitFor(() => expect(result.current.loadError).toEqual({ step: "select", conversationId: "t-2" }));
		expect(useElenchStore.getState().threadId).toBe("t-3");

		act(() => result.current.retryLoad());
		await waitFor(() => expect(useElenchStore.getState().threadId).toBe("t-2"));
		expect(result.current.loadError).toBeNull();
	});
});
