// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 D4): the client half of the mutation contract — pending state, optimistic patch
// with snapshot rollback, invalidation of every declared key, and one treatment per error kind.
// #6755: a call that gets no server answer is a `network` failure the person is told about, and
// the declared keys are still invalidated.
// #7741: the standard failure path — a failure that is safe to retry gets one toast with Retry.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useForm } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push, toast } = vi.hoisted(() => ({
	push: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("sonner", () => ({ toast }));

import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { endSession, useSessionState } from "@/lib/stores/use-session-state";

const KEY = ["projects", "acme"];

/** The options argument of a toast that offers Retry. */
const RETRY = expect.objectContaining({
	action: expect.objectContaining({ label: "Retry", onClick: expect.any(Function) }),
});

/** The Retry handler of the toast at call `index`; fails the test if that toast offered none. */
function retryOf(index = 0): () => void {
	const options: unknown = toast.error.mock.calls[index]?.[1];
	if (typeof options !== "object" || options === null || !("action" in options)) {
		throw new Error(`toast ${index} offered no Retry`);
	}
	const action: unknown = options.action;
	if (typeof action !== "object" || action === null || !("onClick" in action) || typeof action.onClick !== "function") {
		throw new Error(`toast ${index} has no Retry handler`);
	}
	const onClick: unknown = action.onClick;
	return () => {
		if (typeof onClick === "function") onClick();
	};
}

/** A fresh client + wrapper per test, seeded with one cached list. */
function setup() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	client.setQueryData(KEY, ["alpha"]);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
}

/** What `navigator.onLine` answers in this file; reset to online before every test. */
let online = true;
Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });

beforeEach(() => {
	online = true;
	useSessionState.setState({ status: "active", dismissed: false });
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

	it("routes an entitlement refusal to the caller's upgrade surface and a lost session to the session-ended state", async () => {
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
		expect(useSessionState.getState().status).toBe("active");

		const signedOut = async (): Promise<ActionResult<string>> => ({ ok: false, error: { kind: "unauthenticated" } });
		const { result: b } = renderHook(() => useActionMutation(signedOut, { invalidates: [] }), { wrapper });
		await act(async () => {
			await b.current.mutateAsync(undefined).catch(() => {});
		});
		// #6756: the session-ended dialog, not a redirect — the page stays where it is.
		expect(useSessionState.getState().status).toBe("ended");
		expect(push).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("after the session has ended, an attempt calls no action and brings the dialog back", async () => {
		const { wrapper } = setup();
		// Ended, and the person chose "Stay on this page": the banner is up, not the dialog.
		endSession();
		useSessionState.getState().stay();
		expect(useSessionState.getState()).toMatchObject({ status: "ended", dismissed: true });

		const action = vi.fn(async (name: string): Promise<ActionResult<string>> => ({ ok: true, data: name }));
		const onSuccess = vi.fn();
		const { result } = renderHook(() => useActionMutation(action, { invalidates: [], onSuccess }), { wrapper });
		let failure: unknown;
		await act(async () => {
			await result.current.mutateAsync("alpha").catch((e: unknown) => {
				failure = e;
			});
		});

		expect(action).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
		expect(failure).toMatchObject({ error: { kind: "unauthenticated" } });
		expect(useSessionState.getState()).toMatchObject({ status: "ended", dismissed: false });
		expect(toast.error).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
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

	it("hands a refusal to the caller's inline alert instead of a toast when it renders one (#6120)", async () => {
		const { wrapper } = setup();
		const onRefusal = vi.fn();
		const action = async (): Promise<ActionResult<string>> => ({
			ok: false,
			error: { kind: "conflict", message: "A promotion into this environment is already in progress." },
		});
		const { result } = renderHook(
			() => useActionMutation(action, { invalidates: [KEY], onRefusal }),
			{ wrapper },
		);
		await act(async () => {
			await result.current.mutateAsync(undefined).catch(() => {});
		});
		expect(onRefusal).toHaveBeenCalledWith({
			kind: "conflict",
			message: "A promotion into this environment is already in progress.",
		});
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("still toasts an unexpected failure when the caller renders refusals inline — that is not a refusal", async () => {
		const { wrapper } = setup();
		const onRefusal = vi.fn();
		const action = async (): Promise<ActionResult<string>> => ({
			ok: false,
			error: { kind: "unexpected", ref: "abc123" },
		});
		const { result } = renderHook(
			() => useActionMutation(action, { invalidates: [KEY], onRefusal }),
			{ wrapper },
		);
		await act(async () => {
			await result.current.mutateAsync(undefined).catch(() => {});
		});
		expect(onRefusal).not.toHaveBeenCalled();
		expect(toast.error).toHaveBeenCalledWith("Something went wrong on our side. Reference: abc123", RETRY);
	});

	it("tells the person when the call itself rejects, rolls back, and still invalidates (#6755)", async () => {
		const { client, wrapper } = setup();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const action = vi.fn(async (): Promise<ActionResult<string>> => {
			throw new TypeError("Failed to fetch");
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
		expect(action).toHaveBeenCalledTimes(1);
		expect(client.getQueryData(KEY)).toEqual(["alpha"]);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(toast.error).toHaveBeenCalledWith(
			"We couldn't confirm that change. Check it before trying again.",
		);
		expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
		await waitFor(() => expect(result.current.error?.error).toEqual({ kind: "network", sent: true }));
	});

	it("does not call the action while the browser is offline, and says nothing was changed (#6755)", async () => {
		const { client, wrapper } = setup();
		online = false;
		const action = vi.fn(async (): Promise<ActionResult<string>> => ({ ok: true, data: "x" }));
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
		expect(action).not.toHaveBeenCalled();
		expect(client.getQueryData(KEY)).toEqual(["alpha"]);
		expect(toast.error).toHaveBeenCalledWith("You appear to be offline. Nothing was changed.", RETRY);
		await waitFor(() => expect(result.current.error?.error).toEqual({ kind: "network", sent: false }));
		expect(result.current.isPaused).toBe(false);
	});

	it("lets a redirect thrown by the action through without a toast (#6755)", async () => {
		const { wrapper } = setup();
		const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
			digest: "NEXT_REDIRECT;push;/acme;307;",
		});
		const action = async (): Promise<ActionResult<string>> => {
			throw redirect;
		};
		const { result } = renderHook(() => useActionMutation(action, { invalidates: [] }), { wrapper });
		let caught: unknown;
		await act(async () => {
			await result.current.mutateAsync(undefined).catch((e: unknown) => {
				caught = e;
			});
		});
		expect(caught).toBe(redirect);
		expect(toast.error).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
	});

	it("writes validation errors to the given form: known fields in place, the rest in the root error (#6755)", async () => {
		const { wrapper } = setup();
		const onValidationError = vi.fn();
		const action = async (): Promise<ActionResult<string>> => ({
			ok: false,
			error: {
				kind: "validation",
				message: "Check the highlighted fields.",
				fields: { name: ["That name is taken."], region: ["Pick a region."] },
			},
		});
		const { result } = renderHook(
			() => {
				const form = useForm<{ name: string }>({ defaultValues: { name: "" } });
				const mutation = useActionMutation(action, {
					invalidates: [],
					form: { instance: form, fields: ["name"] },
					onValidationError,
				});
				return { form, mutation, errors: form.formState.errors };
			},
			{ wrapper },
		);
		await act(async () => {
			await result.current.mutation.mutateAsync(undefined).catch(() => {});
		});
		await waitFor(() => expect(result.current.errors.name?.message).toBe("That name is taken."));
		expect(result.current.errors.root?.server?.message).toBe("Pick a region.");
		expect(onValidationError).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("puts the summary sentence in the root error when a validation result names no field (#6755)", async () => {
		const { wrapper } = setup();
		const action = async (): Promise<ActionResult<string>> => ({
			ok: false,
			error: { kind: "validation", message: "Check the highlighted fields.", fields: {} },
		});
		const { result } = renderHook(
			() => {
				const form = useForm<{ name: string }>({ defaultValues: { name: "" } });
				const mutation = useActionMutation(action, {
					invalidates: [],
					form: { instance: form, fields: ["name"] },
				});
				return { mutation, errors: form.formState.errors };
			},
			{ wrapper },
		);
		await act(async () => {
			await result.current.mutation.mutateAsync(undefined).catch(() => {});
		});
		await waitFor(() =>
			expect(result.current.errors.root?.server?.message).toBe("Check the highlighted fields."),
		);
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("calls closes(false) on success and not on failure (#6755)", async () => {
		const { wrapper } = setup();
		const closes = vi.fn();
		const good = async (): Promise<ActionResult<string>> => ({ ok: true, data: "x" });
		const { result: a } = renderHook(() => useActionMutation(good, { invalidates: [], closes }), { wrapper });
		await act(() => a.current.mutateAsync(undefined));
		expect(closes).toHaveBeenCalledTimes(1);
		expect(closes).toHaveBeenCalledWith(false);

		closes.mockReset();
		const bad = async (): Promise<ActionResult<string>> => ({ ok: false, error: { kind: "unexpected", ref: "r1" } });
		const { result: b } = renderHook(() => useActionMutation(bad, { invalidates: [], closes }), { wrapper });
		await act(async () => {
			await b.current.mutateAsync(undefined).catch(() => {});
		});
		expect(closes).not.toHaveBeenCalled();
	});

	it("submit ignores a second call made before the first has settled, then accepts one again (#6755)", async () => {
		const { wrapper } = setup();
		let release: (v: ActionResult<string>) => void = () => {};
		const action = vi.fn(() => new Promise<ActionResult<string>>((r) => (release = r)));
		const { result } = renderHook(() => useActionMutation(action, { invalidates: [] }), { wrapper });
		act(() => {
			result.current.submit(undefined);
			result.current.submit(undefined);
		});
		await waitFor(() => expect(result.current.isPending).toBe(true));
		act(() => result.current.submit(undefined));
		expect(action).toHaveBeenCalledTimes(1);
		await act(async () => release({ ok: true, data: "x" }));
		await waitFor(() => expect(result.current.isPending).toBe(false));
		act(() => result.current.submit(undefined));
		await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
	});

	it("Retry on an unexpected failure re-invokes the action with the same variables (#7741)", async () => {
		const { wrapper } = setup();
		const action = vi
			.fn<(name: string) => Promise<ActionResult<string>>>()
			.mockResolvedValueOnce({ ok: false, error: { kind: "unexpected", ref: "r1" } })
			.mockResolvedValueOnce({ ok: true, data: "beta" });
		const onSuccess = vi.fn();
		const { result } = renderHook(() => useActionMutation(action, { invalidates: [], onSuccess }), { wrapper });
		act(() => result.current.submit("beta"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
		expect(toast.error).toHaveBeenCalledWith("Something went wrong on our side. Reference: r1", RETRY);
		await waitFor(() => expect(result.current.isPending).toBe(false));

		act(() => retryOf(0)());
		await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("beta", "beta"));
		expect(action).toHaveBeenCalledTimes(2);
		expect(action).toHaveBeenNthCalledWith(2, "beta");
		expect(toast.error).toHaveBeenCalledTimes(1);
	});

	it("offers no Retry where trying again would be refused again or may double-apply (#7741)", async () => {
		const { wrapper } = setup();
		const failures: ActionResult<string>[] = [
			{ ok: false, error: { kind: "conflict", message: "Already exists." } },
			{ ok: false, error: { kind: "forbidden", message: "Not allowed." } },
			{ ok: false, error: { kind: "not-found", message: "Gone." } },
			{ ok: false, error: { kind: "validation", message: "Check the name.", fields: {} } },
			{ ok: false, error: { kind: "entitlement", message: "A Pro feature.", feature: "teams" } },
		];
		for (const failure of failures) {
			const { result } = renderHook(() => useActionMutation(async () => failure, { invalidates: [] }), { wrapper });
			await act(async () => {
				await result.current.mutateAsync(undefined).catch(() => {});
			});
		}
		// A call that was sent and got no answer may already have applied.
		const unanswered = async (): Promise<ActionResult<string>> => {
			throw new TypeError("Failed to fetch");
		};
		const { result } = renderHook(() => useActionMutation(unanswered, { invalidates: [] }), { wrapper });
		await act(async () => {
			await result.current.mutateAsync(undefined).catch(() => {});
		});
		expect(toast.error).toHaveBeenCalledTimes(failures.length + 1);
		for (const call of toast.error.mock.calls) expect(call).toHaveLength(1);
	});

	it("Retry after an offline failure calls the action once the browser is back online (#7741)", async () => {
		const { wrapper } = setup();
		online = false;
		const action = vi.fn(async (name: string): Promise<ActionResult<string>> => ({ ok: true, data: name }));
		const { result } = renderHook(() => useActionMutation(action, { invalidates: [] }), { wrapper });
		act(() => result.current.submit("alpha"));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("You appear to be offline. Nothing was changed.", RETRY));
		await waitFor(() => expect(result.current.isPending).toBe(false));
		expect(action).not.toHaveBeenCalled();

		online = true;
		act(() => retryOf(0)());
		await waitFor(() => expect(action).toHaveBeenCalledWith("alpha"));
	});
});
