// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6761 — the console's one confirmation owns three things its callers used to wire by hand:
// the pending state, closing when the action has succeeded, and staying open when it has not.
//
// Each is asserted for both forms the confirmed action can take — a contract mutation, and a plain
// function — because a caller picks one and must get the same dialog either way. The `destroy`
// severity is asserted from the outside too: the primary button does nothing until the resource's
// name has been typed.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast }));

import { ConfirmAction, type ConfirmSeverity } from "@/components/confirm/confirm-action";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";

interface DeleteInput {
	id: string;
}
type DeleteAction = (input: DeleteInput) => Promise<ActionResult<DeleteInput>>;

/** A promise settled by the test, so the in-flight state can be looked at. */
function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	let reject: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Renders under a fresh QueryClient, which the mutation contract reads. */
function Wrapper({ children }: { children: ReactNode }) {
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
			}),
	);
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The dialog over a contract mutation, open from the start; `onOpenChange` is reported. */
function MutationHarness({
	action,
	variables,
	onOpenChange,
	severity = { level: "confirm" },
}: {
	action: DeleteAction;
	variables: DeleteInput | null;
	onOpenChange: (open: boolean) => void;
	severity?: ConfirmSeverity;
}) {
	const [open, setOpen] = useState(true);
	const mutation = useActionMutation(action, { invalidates: [] });
	return (
		<ConfirmAction
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				setOpen(next);
			}}
			title="Delete channel?"
			description="This cannot be undone."
			confirmLabel="Delete channel"
			pendingLabel="Deleting…"
			severity={severity}
			mutation={mutation}
			variables={variables}
		/>
	);
}

/** The dialog over a plain function, open from the start; `onOpenChange` is reported. */
function RunHarness({
	run,
	onOpenChange,
}: {
	run: () => unknown;
	onOpenChange: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(true);
	return (
		<ConfirmAction
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				setOpen(next);
			}}
			title="Remove the logo?"
			description="This cannot be undone."
			confirmLabel="Remove logo"
			pendingLabel="Removing…"
			severity={{ level: "confirm" }}
			run={run}
		/>
	);
}

beforeEach(() => {
	toast.success.mockReset();
	toast.error.mockReset();
});

describe("ConfirmAction over a contract mutation", () => {
	it("is pending while the action runs, and closes when it has succeeded", async () => {
		const user = userEvent.setup();
		const answer = deferred<ActionResult<DeleteInput>>();
		const action = vi.fn<DeleteAction>(() => answer.promise);
		const onOpenChange = vi.fn();
		render(<MutationHarness action={action} variables={{ id: "c-1" }} onOpenChange={onOpenChange} />, {
			wrapper: Wrapper,
		});

		await user.click(screen.getByRole("button", { name: "Delete channel" }));

		const busy = await screen.findByRole("button", { name: "Deleting…" });
		expect(busy).toBeDisabled();
		expect(busy).toHaveAttribute("aria-busy", "true");
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		expect(action).toHaveBeenCalledWith({ id: "c-1" });
		expect(onOpenChange).not.toHaveBeenCalled();

		answer.resolve({ ok: true, data: { id: "c-1" } });
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
	});

	it("cannot be dismissed while the action runs", async () => {
		const user = userEvent.setup();
		const answer = deferred<ActionResult<DeleteInput>>();
		const onOpenChange = vi.fn();
		render(
			<MutationHarness
				action={() => answer.promise}
				variables={{ id: "c-1" }}
				onOpenChange={onOpenChange}
			/>,
			{ wrapper: Wrapper },
		);

		await user.click(screen.getByRole("button", { name: "Delete channel" }));
		await screen.findByRole("button", { name: "Deleting…" });
		await user.keyboard("{Escape}");

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		answer.resolve({ ok: true, data: { id: "c-1" } });
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("stays open when the action is refused, and can be confirmed again", async () => {
		const user = userEvent.setup();
		const action = vi.fn<DeleteAction>(async () => ({
			ok: false,
			error: { kind: "conflict", message: "A policy still routes here." },
		}));
		const onOpenChange = vi.fn();
		render(<MutationHarness action={action} variables={{ id: "c-1" }} onOpenChange={onOpenChange} />, {
			wrapper: Wrapper,
		});

		await user.click(screen.getByRole("button", { name: "Delete channel" }));
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith("A policy still routes here."));

		expect(onOpenChange).not.toHaveBeenCalled();
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
		const again = await screen.findByRole("button", { name: "Delete channel" });
		await waitFor(() => expect(again).toBeEnabled());
		await user.click(again);
		await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
	});

	it("does nothing while there is nothing to act on", async () => {
		const user = userEvent.setup();
		const action = vi.fn<DeleteAction>(async (input) => ({ ok: true, data: input }));
		const onOpenChange = vi.fn();
		render(<MutationHarness action={action} variables={null} onOpenChange={onOpenChange} />, {
			wrapper: Wrapper,
		});

		await user.click(screen.getByRole("button", { name: "Delete channel" }));

		expect(action).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("Cancel closes it without running the action", async () => {
		const user = userEvent.setup();
		const action = vi.fn<DeleteAction>(async (input) => ({ ok: true, data: input }));
		const onOpenChange = vi.fn();
		render(<MutationHarness action={action} variables={{ id: "c-1" }} onOpenChange={onOpenChange} />, {
			wrapper: Wrapper,
		});

		await user.click(screen.getByRole("button", { name: "Cancel" }));

		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(action).not.toHaveBeenCalled();
	});
});

describe("ConfirmAction over a plain function", () => {
	it("closes at once when the function is done on return", async () => {
		const user = userEvent.setup();
		const run = vi.fn();
		const onOpenChange = vi.fn();
		render(<RunHarness run={run} onOpenChange={onOpenChange} />);

		await user.click(screen.getByRole("button", { name: "Remove logo" }));

		expect(run).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("is pending until the promise resolves, then closes", async () => {
		const user = userEvent.setup();
		const work = deferred<boolean>();
		const run = vi.fn(() => work.promise);
		const onOpenChange = vi.fn();
		render(<RunHarness run={run} onOpenChange={onOpenChange} />);

		await user.click(screen.getByRole("button", { name: "Remove logo" }));

		expect(await screen.findByRole("button", { name: "Removing…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		expect(onOpenChange).not.toHaveBeenCalled();

		work.resolve(true);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("stays open when the promise resolves false", async () => {
		const user = userEvent.setup();
		const run = vi.fn(async () => false);
		const onOpenChange = vi.fn();
		render(<RunHarness run={run} onOpenChange={onOpenChange} />);

		await user.click(screen.getByRole("button", { name: "Remove logo" }));

		const again = await screen.findByRole("button", { name: "Remove logo" });
		await waitFor(() => expect(again).toBeEnabled());
		expect(run).toHaveBeenCalledTimes(1);
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
	});

	it("stays open when the promise rejects", async () => {
		const user = userEvent.setup();
		const work = deferred<boolean>();
		const run = vi.fn(() => work.promise);
		const onOpenChange = vi.fn();
		render(<RunHarness run={run} onOpenChange={onOpenChange} />);

		await user.click(screen.getByRole("button", { name: "Remove logo" }));
		await screen.findByRole("button", { name: "Removing…" });
		work.reject(new Error("offline"));

		const again = await screen.findByRole("button", { name: "Remove logo" });
		await waitFor(() => expect(again).toBeEnabled());
		expect(onOpenChange).not.toHaveBeenCalled();
	});
});

describe("ConfirmAction at the destroy severity", () => {
	const severity: ConfirmSeverity = {
		level: "destroy",
		subject: "staging",
		consequences: ["The environment record", "Its staged configuration"],
	};

	it("lists what goes and keeps the button disabled until the name is typed", async () => {
		const user = userEvent.setup();
		const action = vi.fn<DeleteAction>(async (input) => ({ ok: true, data: input }));
		const onOpenChange = vi.fn();
		render(
			<MutationHarness
				action={action}
				variables={{ id: "env-1" }}
				onOpenChange={onOpenChange}
				severity={severity}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.getByText("The environment record")).toBeInTheDocument();
		expect(screen.getByText("Its staged configuration")).toBeInTheDocument();
		const confirm = screen.getByRole("button", { name: "Delete channel" });
		expect(confirm).toBeDisabled();

		const field = screen.getByRole("textbox", { name: /type staging to confirm/i });
		await user.type(field, "stagin");
		expect(confirm).toBeDisabled();
		expect(action).not.toHaveBeenCalled();

		await user.type(field, "g");
		await waitFor(() => expect(confirm).toBeEnabled());
		await user.click(confirm);

		await waitFor(() => expect(action).toHaveBeenCalledWith({ id: "env-1" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("stays disabled for a resource with no name", () => {
		render(
			<MutationHarness
				action={async (input) => ({ ok: true, data: input })}
				variables={{ id: "env-1" }}
				onOpenChange={vi.fn()}
				severity={{ level: "destroy", subject: "", consequences: [] }}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.getByRole("button", { name: "Delete channel" })).toBeDisabled();
	});
});
