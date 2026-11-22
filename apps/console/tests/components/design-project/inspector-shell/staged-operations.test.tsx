// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The operations the inspector stages: what they carry, how they are run, and the rail's own
// strip for them. Pinned: a secret is never part of an operation and is joined to it only when it
// runs; an operation that cannot be read, or whose secrets are gone, is refused before any server
// action is called; applying takes each operation off the changeset as it succeeds and leaves the
// rest staged on a refusal; and the strip draws nothing once another surface has claimed them.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

const { enableAddon, saveOverlay, toast } = vi.hoisted(() => ({
	enableAddon: vi.fn(),
	saveOverlay: vi.fn(),
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/app/server/actions/addons", () => ({
	enableAddonAction: (input: unknown) => enableAddon(input),
}));
vi.mock("@/app/server/actions/byo-charts", () => ({
	saveChartWorkloadOverlayAction: (input: unknown) => saveOverlay(input),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("sonner", () => ({ toast }));

import {
	runStagedOperation,
	useApplyStagedOperations,
} from "@/components/design-project/canvas/inspector-shell/apply-staged-operations";
import {
	addonOperationId,
	claimStagedOperations,
	forgetSecrets,
	recallSecrets,
	rememberSecrets,
	useStagedOperationsClaimed,
	withValueAt,
	workloadOperationId,
} from "@/components/design-project/canvas/inspector-shell/staged-operations";
import { StagedOperationsStrip } from "@/components/design-project/canvas/inspector-shell/staged-operations-strip";
import { board } from "@/lib/canvas/store/board";
import type { StagedOperation } from "@/lib/canvas/store/types";

/** A staged add-on install, with `secretPaths` naming the secrets it expects. */
function installOperation(addonId: string, secretPaths: string[] = []): StagedOperation {
	return {
		id: addonOperationId(addonId),
		target: "addon",
		verb: "install",
		targetId: addonId,
		summary: `Install add-on ${addonId}`,
		input: {
			projectId: "p1",
			environmentId: "e1",
			addonId,
			mode: "managed",
			values: { retentionDays: 15, auth: { adminPassword: "" } },
			valuesYaml: "",
			version: null,
			secretPaths,
		},
	};
}

/** A staged chart-workload overlay. */
function overlayOperation(workloadId: string): StagedOperation {
	return {
		id: workloadOperationId(workloadId),
		target: "chart-workload",
		verb: "overlay",
		targetId: workloadId,
		summary: `Chart workload ${workloadId}: replicas and env`,
		input: { projectId: "p1", workloadId, config: { replicas: 2 } },
	};
}

/** The operations staged in the document. */
const staged = () => board.document.getState().operations;

/** Stage `operations` in the document. */
function stage(...operations: StagedOperation[]) {
	act(() => {
		for (const operation of operations) board.document.getState().stageOperation(operation);
	});
}

beforeEach(() => {
	enableAddon.mockReset();
	enableAddon.mockResolvedValue({ ok: true, data: { addonId: "grafana" } });
	saveOverlay.mockReset();
	saveOverlay.mockResolvedValue({ ok: true, data: { workloadId: "w1" } });
	toast.success.mockReset();
	toast.error.mockReset();
	board.reset();
	forgetSecrets(addonOperationId("grafana"));
});

describe("what a staged operation carries", () => {
	it("files one operation per add-on and per workload", () => {
		expect(addonOperationId("grafana")).toBe("addon:grafana");
		expect(workloadOperationId("w1")).toBe("chart-workload:w1");
	});

	it("writes a value at a dotted path without changing what it was given", () => {
		const values = { a: 1, auth: { user: "admin" } };
		expect(withValueAt(values, "auth.password", "s3cret")).toEqual({
			a: 1,
			auth: { user: "admin", password: "s3cret" },
		});
		expect(withValueAt(values, "b", 2)).toEqual({ a: 1, auth: { user: "admin" }, b: 2 });
		expect(withValueAt(values, "a.b", 3)).toEqual({ a: { b: 3 }, auth: { user: "admin" } });
		expect(values).toEqual({ a: 1, auth: { user: "admin" } });
	});

	it("holds secrets beside an operation, in memory, until they are forgotten", () => {
		const id = addonOperationId("grafana");
		expect(recallSecrets(id)).toEqual({});
		rememberSecrets(id, { "auth.adminPassword": "s3cret" });
		expect(recallSecrets(id)).toEqual({ "auth.adminPassword": "s3cret" });
		rememberSecrets(id, {});
		expect(recallSecrets(id)).toEqual({});
		rememberSecrets(id, { "auth.adminPassword": "s3cret" });
		forgetSecrets(id);
		expect(recallSecrets(id)).toEqual({});
	});
});

describe("runStagedOperation", () => {
	it("runs an add-on install through the enable action, with its secrets joined in", async () => {
		const operation = installOperation("grafana", ["auth.adminPassword"]);
		rememberSecrets(operation.id, { "auth.adminPassword": "s3cret" });

		const result = await runStagedOperation(operation);

		expect(result).toEqual({ ok: true, data: { targetId: "grafana" } });
		expect(enableAddon).toHaveBeenCalledTimes(1);
		expect(enableAddon).toHaveBeenCalledWith({
			projectId: "p1",
			environmentId: "e1",
			addonId: "grafana",
			mode: "managed",
			values: { retentionDays: 15, auth: { adminPassword: "s3cret" } },
			valuesYaml: "",
			version: null,
		});
	});

	it("refuses an install whose secrets are gone, and calls nothing", async () => {
		const result = await runStagedOperation(installOperation("grafana", ["auth.adminPassword"]));
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "conflict",
				message:
					"Install add-on grafana: type its secret values again. Secrets are not kept when the page reloads.",
			},
		});
		expect(enableAddon).not.toHaveBeenCalled();
	});

	it("refuses an operation it cannot read, and calls nothing", async () => {
		const broken: StagedOperation = { ...installOperation("grafana"), input: { addonId: 7 } };
		const result = await runStagedOperation(broken);
		expect(result.ok).toBe(false);
		expect(enableAddon).not.toHaveBeenCalled();

		const brokenOverlay: StagedOperation = { ...overlayOperation("w1"), input: "nonsense" };
		expect((await runStagedOperation(brokenOverlay)).ok).toBe(false);
		expect(saveOverlay).not.toHaveBeenCalled();
	});

	it("never runs a removal: removing an add-on is confirmed where it is asked for", async () => {
		const removal: StagedOperation = { ...installOperation("grafana"), verb: "remove" };
		expect((await runStagedOperation(removal)).ok).toBe(false);
		expect(enableAddon).not.toHaveBeenCalled();
	});

	it("runs a workload overlay through the overlay action, with only what it carries", async () => {
		const result = await runStagedOperation(overlayOperation("w1"));
		expect(result).toEqual({ ok: true, data: { targetId: "w1" } });
		expect(saveOverlay).toHaveBeenCalledWith({
			projectId: "p1",
			workloadId: "w1",
			config: { replicas: 2 },
		});
	});

	it("answers the server's refusal as it was given", async () => {
		saveOverlay.mockResolvedValue({
			ok: false,
			error: { kind: "not-found", message: "Chart workload not found" },
		});
		expect(await runStagedOperation(overlayOperation("w1"))).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Chart workload not found" },
		});
	});
});

describe("useApplyStagedOperations", () => {
	it("runs every operation in order and takes each off the changeset", async () => {
		stage(installOperation("grafana"), overlayOperation("w1"));
		const { result } = renderHook(() => useApplyStagedOperations(), { wrapper: queryWrapper() });

		act(() => result.current.submit(staged()));

		await waitFor(() => expect(staged()).toEqual([]));
		expect(enableAddon).toHaveBeenCalledTimes(1);
		expect(saveOverlay).toHaveBeenCalledTimes(1);
	});

	it("on a refusal, leaves what did not run staged and says why where it is asked to", async () => {
		enableAddon.mockResolvedValue({
			ok: false,
			error: { kind: "conflict", message: "This add-on no longer accepts new installs." },
		});
		stage(overlayOperation("w1"), installOperation("grafana"));
		const onRefusal = vi.fn();
		const { result } = renderHook(() => useApplyStagedOperations({ onRefusal }), {
			wrapper: queryWrapper(),
		});

		act(() => result.current.submit(staged()));

		await waitFor(() => expect(onRefusal).toHaveBeenCalledTimes(1));
		expect(onRefusal.mock.calls[0]?.[0]).toMatchObject({
			message: "This add-on no longer accepts new installs.",
		});
		// The overlay ran and left; the install was refused and is still there to fix or discard.
		expect(staged().map((o) => o.id)).toEqual(["addon:grafana"]);
		expect(toast.error).not.toHaveBeenCalled();
	});
});

describe("claiming staged operations", () => {
	it("is held until released, and a release counts once", () => {
		const { result } = renderHook(() => useStagedOperationsClaimed());
		expect(result.current).toBe(false);

		let release: () => void = () => {};
		act(() => {
			release = claimStagedOperations();
		});
		expect(result.current).toBe(true);

		act(() => {
			release();
			release();
		});
		expect(result.current).toBe(false);
	});
});

describe("StagedOperationsStrip", () => {
	it("draws nothing when nothing is staged", () => {
		const { container } = render(<StagedOperationsStrip />, { wrapper: queryWrapper() });
		expect(container).toBeEmptyDOMElement();
	});

	it("says how many are staged and that they apply directly, and lists them", () => {
		stage(installOperation("grafana"), overlayOperation("w1"));
		render(<StagedOperationsStrip />, { wrapper: queryWrapper() });
		const strip = screen.getByRole("region", { name: "Staged changes that apply directly" });
		expect(strip).toHaveTextContent("2 changes are staged");
		expect(strip).toHaveTextContent("Install add-on grafana");
		expect(strip).toHaveTextContent("Chart workload w1: replicas and env");
	});

	it("Apply runs them and the strip goes away", async () => {
		const user = userEvent.setup();
		stage(overlayOperation("w1"));
		render(<StagedOperationsStrip />, { wrapper: queryWrapper() });
		await user.click(screen.getByRole("button", { name: "Apply now" }));

		await waitFor(() => expect(staged()).toEqual([]));
		expect(saveOverlay).toHaveBeenCalledTimes(1);
		expect(screen.queryByRole("region")).not.toBeInTheDocument();
	});

	it("says a refusal in the strip, and keeps the operation", async () => {
		saveOverlay.mockResolvedValue({
			ok: false,
			error: { kind: "not-found", message: "Chart workload not found" },
		});
		const user = userEvent.setup();
		stage(overlayOperation("w1"));
		render(<StagedOperationsStrip />, { wrapper: queryWrapper() });
		await user.click(screen.getByRole("button", { name: "Apply now" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Chart workload not found");
		expect(staged()).toHaveLength(1);
	});

	it("Discard takes them off the changeset without running anything", async () => {
		const user = userEvent.setup();
		const operation = installOperation("grafana", ["auth.adminPassword"]);
		rememberSecrets(operation.id, { "auth.adminPassword": "s3cret" });
		stage(operation);
		render(<StagedOperationsStrip />, { wrapper: queryWrapper() });
		await user.click(screen.getByRole("button", { name: "Discard" }));

		expect(staged()).toEqual([]);
		expect(recallSecrets(operation.id)).toEqual({});
		expect(enableAddon).not.toHaveBeenCalled();
	});

	it("draws nothing once another surface has claimed the operations", () => {
		stage(overlayOperation("w1"));
		render(<StagedOperationsStrip />, { wrapper: queryWrapper() });
		expect(screen.getByRole("region")).toBeInTheDocument();

		let release: () => void = () => {};
		act(() => {
			release = claimStagedOperations();
		});
		expect(screen.queryByRole("region")).not.toBeInTheDocument();
		act(() => release());
		expect(screen.getByRole("region")).toBeInTheDocument();
	});
});
