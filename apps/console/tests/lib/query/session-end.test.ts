// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6756: a read answered UNAUTHORIZED is read as `"sign-in"` and ends the session state from ONE
// place, the QueryCache's `onError`. Once the session has ended (from any source) the browser's
// reads stop: what is in flight is cancelled, and a later fetch is held and sends nothing.

import { ORPCError } from "@orpc/client";
import { onlineManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQueryClient } from "@/lib/query/client";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { endSession, useSessionState } from "@/lib/stores/use-session-state";

/** What the read router answers when there is no session. */
function unauthorized(): Error {
	return new ORPCError("UNAUTHORIZED", { defined: true, status: 401 });
}

/** Lets pending promise callbacks and zero-delay timers run. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	useSessionState.setState({ status: "active", dismissed: false });
	onlineManager.setOnline(true);
});
afterEach(() => {
	useSessionState.setState({ status: "active", dismissed: false });
	onlineManager.setOnline(true);
});

// FIRST in this file on purpose. Mounting a client installs TanStack's own online/offline window
// listener only if nothing has replaced it yet, and ending a session replaces it for the rest of
// the file — so run later, the "coming back online" assertion below would pass with nothing to refuse.
describe("an ended session stops the browser's reads", () => {
	it("cancels what is in flight in every tenant's client, and holds what is asked for later", async () => {
		const acme = getQueryClient("acme");
		const globex = getQueryClient("globex");
		// Mounted, as under the provider: this is what installs TanStack's own online/offline listener.
		acme.mount();
		const aborted: string[] = [];
		/** A read that never answers, and records its tenant when its request is aborted. */
		const hanging = (tenant: string) => ({ signal }: { signal: AbortSignal }) =>
			new Promise<string>(() => {
				signal.addEventListener("abort", () => aborted.push(tenant));
			});
		const settled = Promise.all([
			acme.fetchQuery({ queryKey: ["session-end", "slow"], queryFn: hanging("acme") }).catch(() => "cancelled"),
			globex.fetchQuery({ queryKey: ["session-end", "slow"], queryFn: hanging("globex") }).catch(() => "cancelled"),
		]);
		await tick();
		expect(aborted).toEqual([]);

		endSession();

		expect(await settled).toEqual(["cancelled", "cancelled"]);
		expect(aborted.sort()).toEqual(["acme", "globex"]);

		const later = vi.fn(async () => "rows");
		void acme.prefetchQuery({ queryKey: ["session-end", "later"], queryFn: later });
		await tick();
		expect(later).not.toHaveBeenCalled();
		expect(acme.getQueryState(["session-end", "later"])?.fetchStatus).toBe("paused");

		// The browser coming back online must not release what is held.
		window.dispatchEvent(new Event("online"));
		await tick();
		expect(onlineManager.isOnline()).toBe(false);
		expect(later).not.toHaveBeenCalled();
		acme.unmount();
	});
});

describe("readRefusalOf — the sign-in refusal", () => {
	it("reads a declared UNAUTHORIZED as sign-in, and never retries it", () => {
		expect(readRefusalOf(unauthorized())).toBe("sign-in");
		expect(retryUnlessRefused(0, unauthorized())).toBe(false);
	});

	it("does not read an UNAUTHORIZED the router did not declare, or another error, as sign-in", () => {
		expect(readRefusalOf(new ORPCError("UNAUTHORIZED"))).toBeNull();
		expect(readRefusalOf(new Error("Unauthorized"))).toBeNull();
		expect(readRefusalOf(new ORPCError("FORBIDDEN", { defined: true }))).toBe("forbidden");
	});
});

describe("the QueryCache ends the session on a sign-in refusal", () => {
	it("ends it after ONE request: the refusal is not retried", async () => {
		const queryFn = vi.fn(async (): Promise<string> => {
			throw unauthorized();
		});
		await expect(
			getQueryClient("acme").fetchQuery({ queryKey: ["session-end", "refused"], queryFn, retryDelay: 0 }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(queryFn).toHaveBeenCalledTimes(1);
		expect(useSessionState.getState().status).toBe("ended");
	});

	it("leaves the session alone for any other failure, and still retries that once", async () => {
		const queryFn = vi.fn(async (): Promise<string> => {
			throw new Error("Connection terminated unexpectedly");
		});
		await expect(
			getQueryClient("acme").fetchQuery({ queryKey: ["session-end", "failed"], queryFn, retryDelay: 0 }),
		).rejects.toThrow("Connection terminated unexpectedly");
		expect(queryFn).toHaveBeenCalledTimes(2);
		expect(useSessionState.getState().status).toBe("active");
	});

	it("leaves the session alone for a forbidden read", async () => {
		const queryFn = vi.fn(async (): Promise<string> => {
			throw new ORPCError("FORBIDDEN", { defined: true, status: 403 });
		});
		await expect(
			getQueryClient("acme").fetchQuery({ queryKey: ["session-end", "forbidden"], queryFn, retry: false }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(useSessionState.getState().status).toBe("active");
	});
});
