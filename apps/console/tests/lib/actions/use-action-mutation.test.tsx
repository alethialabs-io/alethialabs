// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 D4): the client half of the mutation contract — pending state, optimistic patch
// with snapshot rollback, invalidation of every declared key, and one treatment per error kind.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push, toast } = vi.hoisted(() => ({
	push: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast }));

import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";

const KEY = ["projects", "acme"];

/** A fresh client + wrapper per test, seeded with one cached list. */
function setup() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	client.setQueryData(KEY, ["alpha"]);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
}

beforeEach(() => {
	push.mockReset();
	toast.success.mockReset();
	toast.error.mockReset();
});

describe("useActionMutation", () => {
	it("applies the optimistic patch, keeps it on success, and invalidates the declared keys", async () => {
		const { client, wrapper } = setup();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const action = vi.fn(async (name: string): Promise<ActionResult<string>> => ({ ok: true, data: name }));
		const { result } = renderHook(
			() =>
				useActionMutation(action, {
					invalidates: [KEY],
					optimistic: [{ key: KEY, update: (cur, name) => [...(Array.isArray(cur) ? cur : []), name] }],
					successMessage: "Project created",
				}),
			{ wrapper },
		);
		await act(() => result.current.mutateAsync("beta"));
		expect(client.getQueryData(KEY)).toEqual(["alpha", "beta"]);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
		expect(toast.success).toHaveBeenCalledWith("Project created");
	});

	it("rolls the optimistic patch back when the action refuses, and toasts the server's message", async () => {
		const { client, wrapper } = setup();
		const action = async (): Promise<ActionResult<string>> => ({
			ok: false,
			error: { kind: "conflict", message: "A project with that name already exists." },
		});
		const { result } = renderHook(
			() =>
				useActionMutation(action, {
					invalidates: [KEY],
					optimistic: [{ key: KEY, update: () => ["alpha", "beta"] }],
				}),
			{ wrapper },
		);
		await act(async () => {
			await result.current.mutateAsync(undefined).catch(() => {});
		});
		expect(client.getQueryData(KEY)).toEqual(["alpha"]);
		expect(toast.error).toHaveBeenCalledWith("A project with that name already exists.");
	});

	it("sends validation errors to the form, not a toast", async () => {
		const { wrapper } = setup();
		const onValidationError = vi.fn();
		const action = async (): Promise<ActionResult<string>> => ({
			ok: false,
			error: { kind: "validation", message: "Name is required", fields: { name: ["Name is required"] } },
		});
		const { result } = renderHook(() => useActionMutation(action, { invalidates: [], onValidationError }), { wrapper });
		await act(async () => {
			await result.current.mutateAsync(undefined).catch(() => {});
		});
		expect(onValidationError).toHaveBeenCalledWith({ name: ["Name is required"] });
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("routes an entitlement refusal to the caller's upgrade surface and a lost session to sign-in", async () => {
		const { wrapper } = setup();
		const onEntitlement = vi.fn();
		const refusal = async (): Promise<ActionResult<string>> => ({
			ok: false,
			error: { kind: "entitlement", message: "Teams are a Pro feature.", feature: "teams" },
		});
		const { result: a } = renderHook(() => useActionMutation(refusal, { invalidates: [], onEntitlement }), { wrapper });
		await act(async () => {
			await a.current.mutateAsync(undefined).catch(() => {});
		});
		expect(onEntitlement).toHaveBeenCalledWith("teams", "Teams are a Pro feature.");

		const signedOut = async (): Promise<ActionResult<string>> => ({ ok: false, error: { kind: "unauthenticated" } });
		const { result: b } = renderHook(() => useActionMutation(signedOut, { invalidates: [] }), { wrapper });
		await act(async () => {
			await b.current.mutateAsync(undefined).catch(() => {});
		});
		expect(push).toHaveBeenCalledWith("/login");
	});

	it("is pending while the action runs (the double-submit guard binds to this)", async () => {
		const { wrapper } = setup();
		let release: (v: ActionResult<string>) => void = () => {};
		const action = () => new Promise<ActionResult<string>>((r) => (release = r));
		const { result } = renderHook(() => useActionMutation(action, { invalidates: [] }), { wrapper });
		act(() => result.current.mutate(undefined));
		await waitFor(() => expect(result.current.isPending).toBe(true));
		await act(async () => release({ ok: true, data: "x" }));
		await waitFor(() => expect(result.current.isPending).toBe(false));
	});
});
