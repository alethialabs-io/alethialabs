// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from "vitest";
import { isSupportAcked, useNotificationsStore } from "@/lib/stores/use-notifications-store";

beforeEach(() => {
	localStorage.clear();
	useNotificationsStore.setState({ readJobIds: [], supportAcks: [] });
});

describe("useNotificationsStore", () => {
	it("markRead adds an id, idempotently", () => {
		const { markRead } = useNotificationsStore.getState();
		markRead("a");
		markRead("a");
		expect(useNotificationsStore.getState().readJobIds).toEqual(["a"]);
	});

	it("markAllRead merges a batch without duplicates", () => {
		useNotificationsStore.getState().markRead("a");
		useNotificationsStore.getState().markAllRead(["b", "a", "c"]);
		const ids = useNotificationsStore.getState().readJobIds;
		expect(ids).toHaveLength(3);
		expect(new Set(ids)).toEqual(new Set(["a", "b", "c"]));
	});

	it("persists only the read-id sets to localStorage (partialize)", () => {
		useNotificationsStore.getState().markRead("x");
		const raw = localStorage.getItem("notifications-store");
		expect(raw).toBeTruthy();
		const parsed = JSON.parse(raw ?? "{}");
		expect(parsed.state.readJobIds).toContain("x");
		expect(new Set(Object.keys(parsed.state))).toEqual(
			new Set(["readJobIds", "supportAcks"]),
		);
	});

	it("caps the remembered set at 200 ids", () => {
		const ids = Array.from({ length: 250 }, (_, i) => `j${i}`);
		useNotificationsStore.getState().markAllRead(ids);
		expect(useNotificationsStore.getState().readJobIds).toHaveLength(200);
	});

	it("a support acknowledgement covers the messages it saw, not a later staff reply (G-08)", () => {
		useNotificationsStore
			.getState()
			.markSupportRead({ caseId: "c1", lastMessageAt: "2026-11-20T10:00:00.000Z" });
		const { supportAcks } = useNotificationsStore.getState();
		expect(isSupportAcked(supportAcks, "c1", "2026-11-20T10:00:00.000Z")).toBe(true);
		expect(isSupportAcked(supportAcks, "c1", "2026-11-20T10:05:00.000Z")).toBe(false);
		expect(isSupportAcked(supportAcks, "c2", "2026-11-20T10:00:00.000Z")).toBe(false);
	});

	it("acknowledging a case again replaces its older acknowledgement", () => {
		const { markSupportRead, markAllSupportRead } = useNotificationsStore.getState();
		markSupportRead({ caseId: "c1", lastMessageAt: "2026-11-20T10:00:00.000Z" });
		markAllSupportRead([
			{ caseId: "c1", lastMessageAt: "2026-11-20T11:00:00.000Z" },
			{ caseId: "c2", lastMessageAt: "2026-11-20T09:00:00.000Z" },
		]);
		const { supportAcks } = useNotificationsStore.getState();
		expect(supportAcks).toEqual([
			{ caseId: "c1", lastMessageAt: "2026-11-20T11:00:00.000Z" },
			{ caseId: "c2", lastMessageAt: "2026-11-20T09:00:00.000Z" },
		]);
	});

	it("drops v1 support ids on migration and keeps the job read marks", async () => {
		localStorage.setItem(
			"notifications-store",
			JSON.stringify({ state: { readJobIds: ["j1"], readSupportCaseIds: ["c1"] }, version: 1 }),
		);
		await useNotificationsStore.persist.rehydrate();
		const state = useNotificationsStore.getState();
		expect(state.readJobIds).toEqual(["j1"]);
		expect(state.supportAcks).toEqual([]);
	});
});
