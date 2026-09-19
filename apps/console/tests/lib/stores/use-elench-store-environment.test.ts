// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// An Elench project conversation plans and deploys against ONE environment. Switching the topbar
// switcher (or Shift+Tab, or landing on a deep link) must re-scope an OPEN panel — and re-scoping
// is emphatically NOT a workspace switch: the environment is request context rebuilt on every
// turn, so the thread and the chat lineage survive it. Before this, the panel kept whatever
// environment it was opened on and the assistant planned somewhere the user was no longer looking.
//
// The two halves that must not drift:
//   - `syncEnvironment` moves `ctx.environmentId` and NOTHING else (thread + epoch kept), and
//     refuses every request that is not about the open project conversation.
//   - `elenchChatId` — the token that recreates the underlying chat — must not read the
//     environment, or every switch would silently wipe the transcript.

import { beforeEach, describe, expect, it } from "vitest";
import { elenchChatId, useElenchStore } from "@/lib/stores/use-elench-store";

const PROJECT = "22222222-2222-2222-2222-222222222222";
const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
const DEV_ENV = "44444444-4444-4444-4444-444444444444";
const PROD_ENV = "55555555-5555-5555-5555-555555555555";

/** An open project panel on `DEV_ENV`, mid-conversation (a persisted thread, epoch already bumped). */
function openOnDevEnv(): void {
	useElenchStore.setState({
		open: true,
		view: "panel",
		ctx: { kind: "project", projectId: PROJECT, environmentId: DEV_ENV },
		threadId: "project-thread",
		epoch: 3,
		mainView: "chat",
	});
}

beforeEach(() => {
	useElenchStore.setState({
		open: false,
		view: "panel",
		ctx: { kind: "org" },
		threadId: null,
		epoch: 0,
		mainView: "chat",
	});
});

describe("syncEnvironment — re-scoping an open project conversation", () => {
	it("swaps the environment in place: same thread, same epoch", () => {
		openOnDevEnv();
		useElenchStore.getState().syncEnvironment(PROJECT, PROD_ENV);
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({
			kind: "project",
			projectId: PROJECT,
			environmentId: PROD_ENV,
		});
		// The environment is request context, not a new lineage — the transcript survives.
		expect(s.threadId).toBe("project-thread");
		expect(s.epoch).toBe(3);
	});

	it("accepts null — the project's default environment, resolved server-side", () => {
		openOnDevEnv();
		useElenchStore.getState().syncEnvironment(PROJECT, null);
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({
			kind: "project",
			projectId: PROJECT,
			environmentId: null,
		});
		expect(s.threadId).toBe("project-thread");
		expect(s.epoch).toBe(3);
	});

	it("is a no-op when the surface is closed (nothing to re-scope)", () => {
		openOnDevEnv();
		useElenchStore.setState({ open: false });
		useElenchStore.getState().syncEnvironment(PROJECT, PROD_ENV);
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({
			kind: "project",
			projectId: PROJECT,
			environmentId: DEV_ENV,
		});
	});

	it("is a no-op on an org conversation (an org chat has no environment)", () => {
		useElenchStore.setState({ open: true, ctx: { kind: "org" } });
		useElenchStore.getState().syncEnvironment(PROJECT, PROD_ENV);
		expect(useElenchStore.getState().ctx).toEqual({ kind: "org" });
	});

	it("is a no-op for ANOTHER project — a background switcher must not steer this chat", () => {
		openOnDevEnv();
		useElenchStore.getState().syncEnvironment(OTHER_PROJECT, PROD_ENV);
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({
			kind: "project",
			projectId: PROJECT,
			environmentId: DEV_ENV,
		});
		expect(s.epoch).toBe(3);
	});

	it("re-selecting the environment already active changes nothing", () => {
		openOnDevEnv();
		const before = useElenchStore.getState().ctx;
		useElenchStore.getState().syncEnvironment(PROJECT, DEV_ENV);
		// Same value AND the same object — a needless `set` would re-render every subscriber.
		expect(useElenchStore.getState().ctx).toBe(before);
	});
});

describe("workspace switching still resets — the environment did not weaken it", () => {
	it("opening ANOTHER project starts a fresh conversation", () => {
		openOnDevEnv();
		useElenchStore
			.getState()
			.openPanel({ kind: "project", projectId: OTHER_PROJECT, environmentId: PROD_ENV });
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({
			kind: "project",
			projectId: OTHER_PROJECT,
			environmentId: PROD_ENV,
		});
		expect(s.threadId).toBeNull();
		expect(s.epoch).toBe(4);
	});

	it("re-opening the SAME project on a DIFFERENT environment keeps the conversation", () => {
		openOnDevEnv();
		useElenchStore
			.getState()
			.openPanel({ kind: "project", projectId: PROJECT, environmentId: PROD_ENV });
		const s = useElenchStore.getState();
		expect(s.ctx).toEqual({
			kind: "project",
			projectId: PROJECT,
			environmentId: PROD_ENV,
		});
		expect(s.threadId).toBe("project-thread");
		expect(s.epoch).toBe(3);
	});
});

describe("elenchChatId is blind to the environment", () => {
	it("two environments of one project address the SAME chat lineage", () => {
		const dev = elenchChatId(
			{ kind: "project", projectId: PROJECT, environmentId: DEV_ENV },
			3,
		);
		const prod = elenchChatId(
			{ kind: "project", projectId: PROJECT, environmentId: PROD_ENV },
			3,
		);
		const dflt = elenchChatId(
			{ kind: "project", projectId: PROJECT, environmentId: null },
			3,
		);
		expect(prod).toBe(dev);
		expect(dflt).toBe(dev);
	});

	it("but a different project — or a new epoch — is a different lineage", () => {
		const mine = elenchChatId(
			{ kind: "project", projectId: PROJECT, environmentId: DEV_ENV },
			3,
		);
		expect(
			elenchChatId(
				{ kind: "project", projectId: OTHER_PROJECT, environmentId: DEV_ENV },
				3,
			),
		).not.toBe(mine);
		expect(
			elenchChatId(
				{ kind: "project", projectId: PROJECT, environmentId: DEV_ENV },
				4,
			),
		).not.toBe(mine);
	});
});
