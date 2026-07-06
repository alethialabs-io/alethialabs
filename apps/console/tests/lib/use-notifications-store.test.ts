// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it } from "vitest";
import { useNotificationsStore } from "@/lib/stores/use-notifications-store";

beforeEach(() => {
	localStorage.clear();
	useNotificationsStore.setState({ readJobIds: [], readSupportCaseIds: [] });
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
			new Set(["readJobIds", "readSupportCaseIds"]),
		);
	});

	it("caps the remembered set at 200 ids", () => {
		const ids = Array.from({ length: 250 }, (_, i) => `j${i}`);
		useNotificationsStore.getState().markAllRead(ids);
		expect(useNotificationsStore.getState().readJobIds).toHaveLength(200);
	});
});
