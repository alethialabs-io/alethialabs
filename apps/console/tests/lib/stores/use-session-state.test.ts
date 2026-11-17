// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6756: one store says whether the session is still good. It starts `active`, ends once, and a
// second source reporting the same thing notifies nobody again. "Stay on this page" sets the dialog
// aside without un-ending the session, and the next report that it has ended brings it back.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { endSession, isSessionEnded, useSessionState } from "@/lib/stores/use-session-state";

beforeEach(() => {
	useSessionState.setState({ status: "active", dismissed: false });
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

	it("stay() sets the dialog aside, the session stays ended, and the next report brings it back", () => {
		endSession();
		useSessionState.getState().stay();
		expect(useSessionState.getState()).toMatchObject({ status: "ended", dismissed: true });
		expect(isSessionEnded()).toBe(true);
		endSession();
		expect(useSessionState.getState()).toMatchObject({ status: "ended", dismissed: false });
	});

	it("stay() does nothing while the session is active", () => {
		useSessionState.getState().stay();
		expect(useSessionState.getState()).toMatchObject({ status: "active", dismissed: false });
	});
});
