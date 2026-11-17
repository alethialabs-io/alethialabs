// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6756: one store says whether the session is still good. It starts `active`, ends once, and a
// second source reporting the same thing notifies nobody again.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { endSession, isSessionEnded, useSessionState } from "@/lib/stores/use-session-state";

beforeEach(() => {
	useSessionState.setState({ status: "active" });
});

describe("useSessionState", () => {
	it("starts active", () => {
		expect(useSessionState.getState().status).toBe("active");
		expect(isSessionEnded()).toBe(false);
	});

	it("ends once: the second report changes nothing and notifies nobody", () => {
		const listener = vi.fn();
		const unsubscribe = useSessionState.subscribe(listener);
		endSession();
		expect(isSessionEnded()).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		endSession();
		useSessionState.getState().end();
		expect(listener).toHaveBeenCalledTimes(1);
		expect(useSessionState.getState().status).toBe("ended");
		unsubscribe();
	});
});
