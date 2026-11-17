// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The wizard engine (lib/wizard/use-wizard.ts), run against a URL and a viewer made here.
//
// The location below is a query string held in React state, so a `push` or a `replace` re-renders
// the hook the way a router does, and every one of them is recorded: the tests assert on WHICH of
// the two the engine used, because a clamp that adds a history entry breaks Back.
//
// Storage assertions read `sessionStorage` itself.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stepper, WizardDisclosure, WizardFooter, WizardFormError } from "@repo/ui/wizard";
import { useState } from "react";
import type { FieldValues } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyParamPatch } from "@/lib/query/view-url-params";
import { defineWizard } from "@/lib/wizard/define";
import { clearAllWizardDrafts, draftKey, writeDraft } from "@/lib/wizard/draft";
import { SETTLE_FAILED_MESSAGE } from "@/lib/wizard/steps";
import type {
	Settlement,
	UseWizardOptions,
	WizardDefinition,
	WizardLocation,
} from "@/lib/wizard/types";
import {
	DRAFT_WRITE_DELAY_MS,
	UNPLACED_FAILURE_MESSAGE,
	useWizardEngine,
} from "@/lib/wizard/use-wizard";
import {
	EXAMPLE_POOL_DEFAULTS,
	type ExamplePoolValues,
	examplePoolWizard,
} from "./fixtures/example.wizard";

/** One thing the engine did to the location. */
type LocationCall =
	| { readonly via: "push" | "replace"; readonly patch: Readonly<Record<string, string | null>> }
	| { readonly via: "leave"; readonly path: string };

/** What a test controls about the page around the wizard. */
interface Surroundings {
	readonly search: string;
	readonly viewerId: string | null | undefined;
	readonly now: number;
	readonly calls: LocationCall[];
}

const NOW = 1_800_000_000_000;
const VIEWER = "user-1";
const SCOPE = "acme";

/** Values that pass every step of the example wizard. */
const FILLED: ExamplePoolValues = { provider: "aws", region: "eu-west-1", min: 1, surge: "1", note: "" };

/** The engine with a location held in state. Returns the wizard and the query string. */
function useHarness<V extends FieldValues, TOut>(
	definition: WizardDefinition<V, TOut>,
	options: UseWizardOptions<V, TOut>,
	around: Surroundings,
) {
	const [search, setSearch] = useState(around.search);
	const location: WizardLocation = {
		read: (name) => new URLSearchParams(search).get(name),
		push: (patch) => {
			around.calls.push({ via: "push", patch });
			setSearch((current) => applyParamPatch(current, patch));
		},
		replace: (patch) => {
			around.calls.push({ via: "replace", patch });
			setSearch((current) => applyParamPatch(current, patch));
		},
		leave: (path) => {
			around.calls.push({ via: "leave", path });
		},
	};
	const wizard = useWizardEngine(definition, options, {
		location,
		viewerId: around.viewerId,
		now: () => around.now,
	});
	return { wizard, search };
}

/** Mounts a wizard and waits until it is ready. */
async function mount<V extends FieldValues, TOut>(
	definition: WizardDefinition<V, TOut>,
	defaultValues: UseWizardOptions<V, TOut>["defaultValues"],
	around: Partial<Surroundings> = {},
) {
	const calls: LocationCall[] = [];
	const onSubmit = vi.fn<(values: TOut) => void>();
	const initialProps: Surroundings = { search: "", viewerId: VIEWER, now: NOW, calls, ...around };
	const view = renderHook(
		(props: Surroundings) => useHarness(definition, { defaultValues, scope: SCOPE, onSubmit }, props),
		{ initialProps },
	);
	if (initialProps.viewerId !== undefined) {
		await waitFor(() => expect(view.result.current.wizard.ready).toBe(true));
	}
	return {
		view,
		calls: initialProps.calls,
		onSubmit,
		wizard: () => view.result.current.wizard,
		search: () => view.result.current.search,
	};
}

/** Mounts the example wizard. */
function mountPool(defaults: ExamplePoolValues = EXAMPLE_POOL_DEFAULTS, around: Partial<Surroundings> = {}) {
	return mount(examplePoolWizard, defaults, around);
}

/** The example wizard's draft key for the test viewer. */
const POOL_KEY = draftKey({ id: "example-pool", viewerId: VIEWER, scope: SCOPE }, 1);

/** The stored draft of the example wizard, parsed, or null. */
function storedPoolDraft(): unknown {
	const text = window.sessionStorage.getItem(POOL_KEY);
	return text === null ? null : JSON.parse(text);
}

/** Waits long enough for a scheduled draft write to have happened. */
async function pastTheWriteDelay(): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, DRAFT_WRITE_DELAY_MS + 150));
	});
}

/** The values of the wizard with an irreversible step. */
interface OrgValues {
	name: string;
	seats: number;
}

const ORG_DEFAULTS: OrgValues = { name: "Acme", seats: 1 };

/** A three-step wizard whose middle step cannot be repeated; `settle` is the server's answer. */
function orgWizard(settle: () => Promise<Settlement>): WizardDefinition<OrgValues, OrgValues> {
	return defineWizard<OrgValues, OrgValues>({
		id: "create-org",
		presentation: "page",
		schema: z.object({ name: z.string().min(1, "Name it"), seats: z.number() }),
		steps: [
			{ id: "name", label: "Name", fields: ["name"], schema: z.object({ name: z.string().min(1, "Name it") }) },
			{
				id: "pay",
				label: "Pay",
				fields: ["seats"],
				schema: z.object({ seats: z.number().min(1, "At least one seat") }),
				gate: { kind: "irreversible", settle },
			},
			{ id: "invite", label: "Invite", fields: [], schema: z.object({}) },
		],
		draft: null,
	});
}

/** The values of the overlay wizard with an external step. */
interface ImportValues {
	repo: string;
	name: string;
}

/** A two-step overlay whose first step owns the params a repository scan comes back with. */
const importWizard = defineWizard<ImportValues, ImportValues>({
	id: "import",
	presentation: "overlay",
	schema: z.object({ repo: z.string().min(1, "Pick a repository"), name: z.string().min(1, "Name it") }),
	steps: [
		{
			id: "source",
			label: "Source",
			fields: ["repo"],
			schema: z.object({ repo: z.string().min(1, "Pick a repository") }),
			gate: { kind: "external", returnParams: ["scan", "code"] },
		},
		{ id: "review", label: "Review", fields: ["name"], schema: z.object({ name: z.string().min(1, "Name it") }) },
	],
	draft: { version: 3, ttlMinutes: 10, schema: z.object({ repo: z.string(), name: z.string() }) },
});

beforeEach(() => {
	window.sessionStorage.clear();
	clearAllWizardDrafts();
});

describe("the step on screen follows the URL", () => {
	it("starts on the first step and leaves a clean URL alone", async () => {
		const { wizard, calls } = await mountPool();
		expect(wizard().current.id).toBe("cloud");
		expect(wizard().stepNumber).toBe(1);
		expect(wizard().stepCount).toBe(4);
		expect(wizard().isLast).toBe(false);
		expect(wizard().restored).toBe(false);
		expect(wizard().settlement).toBeNull();
		expect(wizard().items.map((item) => item.state)).toEqual(["current", "todo", "todo", "todo"]);
		expect(calls).toEqual([]);
	});

	it("shows the step the URL names when every step before it passes", async () => {
		const { wizard, calls } = await mountPool(FILLED, { search: "step=capacity" });
		expect(wizard().current.id).toBe("capacity");
		expect(wizard().items.map((item) => item.state)).toEqual(["done", "done", "current", "todo"]);
		expect(calls).toEqual([]);
	});

	it("replaces a step whose predecessors do not pass with the first that does not", async () => {
		const { wizard, calls, search } = await mountPool(EXAMPLE_POOL_DEFAULTS, { search: "step=review&tab=x" });
		expect(wizard().current.id).toBe("cloud");
		expect(calls).toEqual([{ via: "replace", patch: { step: "cloud" } }]);
		expect(search()).toBe("step=cloud&tab=x");
	});

	it("replaces an unknown step with the first one", async () => {
		const { wizard, calls } = await mountPool(FILLED, { search: "step=nowhere" });
		expect(wizard().current.id).toBe("cloud");
		expect(calls).toEqual([{ via: "replace", patch: { step: "cloud" } }]);
	});

	it("is the last step on the last step", async () => {
		const { wizard } = await mountPool(FILLED, { search: "step=review" });
		expect(wizard().isLast).toBe(true);
		expect(wizard().stepNumber).toBe(4);
	});
});

describe("next, back and goTo", () => {
	it("next puts the current step's issues on its fields and stays", async () => {
		const { wizard, calls } = await mountPool();
		await act(async () => {
			await wizard().next();
		});
		expect(wizard().current.id).toBe("cloud");
		expect(wizard().form.getFieldState("provider").error?.message).toBe("Pick a cloud");
		expect(wizard().formError).toBeNull();
		expect(calls).toEqual([]);
	});

	it("next pushes the following step when the current one passes", async () => {
		const { wizard, calls, search } = await mountPool(FILLED);
		await act(async () => {
			await wizard().next();
		});
		expect(calls).toEqual([{ via: "push", patch: { step: "placement" } }]);
		expect(search()).toBe("step=placement");
		expect(wizard().current.id).toBe("placement");
	});

	it("next skips a step whose `when` is false, and the rail does not show it", async () => {
		const { wizard } = await mountPool({ ...FILLED, provider: "local" });
		expect(wizard().items.map((item) => item.id)).toEqual(["cloud", "capacity", "review"]);
		await act(async () => {
			await wizard().next();
		});
		expect(wizard().current.id).toBe("capacity");
	});

	it("next does nothing on the last step", async () => {
		const { wizard, calls, onSubmit } = await mountPool(FILLED, { search: "step=review" });
		await act(async () => {
			await wizard().next();
		});
		expect(calls).toEqual([]);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("an issue of the step that no field of it owns becomes the form error", async () => {
		const definition = defineWizard<ImportValues, ImportValues>({
			id: "rule",
			presentation: "page",
			schema: z.object({ repo: z.string(), name: z.string() }),
			steps: [
				{
					id: "only",
					label: "Only",
					fields: ["repo", "name"],
					schema: z
						.object({ repo: z.string(), name: z.string() })
						.refine((values) => values.repo !== values.name, { message: "The two must differ" }),
				},
			],
			draft: null,
		});
		const { wizard } = await mount(definition, { repo: "same", name: "same" });
		await act(async () => {
			await wizard().next();
		});
		expect(wizard().formError).toBe("The two must differ");
		act(() => wizard().form.setValue("name", "other"));
		await act(async () => {
			await wizard().next();
		});
		expect(wizard().formError).toBeNull();
	});

	it("back pushes the previous step, and does nothing on the first", async () => {
		const { wizard, calls } = await mountPool(FILLED, { search: "step=capacity" });
		act(() => wizard().back());
		expect(calls).toEqual([{ via: "push", patch: { step: "placement" } }]);
		act(() => wizard().back());
		expect(wizard().current.id).toBe("cloud");
		act(() => wizard().back());
		expect(calls).toHaveLength(2);
	});

	it("goTo moves back freely and forward only as far as the steps pass", async () => {
		const { wizard, calls } = await mountPool({ ...FILLED, region: "" }, { search: "step=placement" });
		act(() => wizard().goTo("review"));
		act(() => wizard().goTo("placement"));
		act(() => wizard().goTo("nowhere"));
		expect(calls).toEqual([]);
		act(() => wizard().goTo("cloud"));
		expect(calls).toEqual([{ via: "push", patch: { step: "cloud" } }]);
		expect(wizard().current.id).toBe("cloud");
		act(() => wizard().goTo("placement"));
		expect(wizard().current.id).toBe("placement");
	});
});

describe("submit never fails silently", () => {
	it("hands the parsed values to onSubmit when every step and the submit schema pass", async () => {
		const { wizard, onSubmit, calls } = await mountPool(FILLED, { search: "step=review" });
		await act(async () => {
			await wizard().submit();
		});
		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledWith(FILLED);
		expect(wizard().formError).toBeNull();
		expect(calls).toEqual([]);
	});

	it("goes to the step owning a field that only fails on submit, with the error on it", async () => {
		const { wizard, onSubmit, calls } = await mountPool({ ...FILLED, surge: "" }, { search: "step=review" });
		await act(async () => {
			await wizard().submit();
		});
		expect(onSubmit).not.toHaveBeenCalled();
		expect(calls).toEqual([{ via: "push", patch: { step: "capacity" } }]);
		expect(wizard().current.id).toBe("capacity");
		expect(wizard().form.getFieldState("surge").error?.message).toBe("At least 1");
		expect(wizard().formError).toBeNull();
	});

	it("marks a step with an error as invalid on the rail", async () => {
		const { wizard } = await mountPool({ ...FILLED, provider: "aws", region: "fsn1" }, { search: "step=review" });
		await act(async () => {
			await wizard().submit();
		});
		expect(wizard().current.id).toBe("placement");
		expect(wizard().form.getFieldState("region").error?.message).toBe("That region is not on this cloud");
		act(() => wizard().goTo("cloud"));
		expect(wizard().items.map((item) => item.state)).toEqual(["current", "invalid", "todo", "todo"]);
	});

	it("shows a failure no field owns as the form error, and stays", async () => {
		const { wizard, onSubmit, calls } = await mountPool({ ...FILLED, note: "refuse" }, { search: "step=review" });
		await act(async () => {
			await wizard().submit();
		});
		expect(onSubmit).not.toHaveBeenCalled();
		expect(wizard().formError).toBe("This pool cannot be created");
		expect(calls).toEqual([]);
	});

	it("does not validate a step that is not shown", async () => {
		const values = { ...FILLED, provider: "local", region: "" };
		const { wizard, onSubmit } = await mountPool(values, { search: "step=review" });
		await act(async () => {
			await wizard().submit();
		});
		expect(onSubmit).toHaveBeenCalledWith(values);
	});

	it("clears a field's error when the field changes", async () => {
		const { wizard } = await mountPool();
		await act(async () => {
			await wizard().next();
		});
		expect(wizard().form.getFieldState("provider").error).toBeDefined();
		act(() => wizard().form.setValue("provider", "aws"));
		expect(wizard().form.getFieldState("provider").error).toBeUndefined();
	});
});

describe("applyFieldErrors — a server's refusal lands somewhere visible", () => {
	it("goes to the step owning the first refused field", async () => {
		const { wizard, calls } = await mountPool(FILLED, { search: "step=review" });
		act(() => wizard().applyFieldErrors({ surge: ["Too high for this plan"], region: ["Not offered"] }));
		expect(calls).toEqual([{ via: "push", patch: { step: "placement" } }]);
		expect(wizard().form.getFieldState("region").error?.message).toBe("Not offered");
		expect(wizard().form.getFieldState("surge").error?.message).toBe("Too high for this plan");
		expect(wizard().formError).toBeNull();
	});

	it("shows a refusal no field owns as the form error", async () => {
		const { wizard, calls } = await mountPool(FILLED, { search: "step=review" });
		act(() => wizard().applyFieldErrors({ quota: ["Your plan allows two pools", "Upgrade to add more"] }));
		expect(wizard().formError).toBe("Your plan allows two pools Upgrade to add more");
		expect(calls).toEqual([]);
	});

	it("says something even when the refusal names nothing", async () => {
		const { wizard } = await mountPool(FILLED, { search: "step=review" });
		act(() => wizard().applyFieldErrors({}));
		expect(wizard().formError).toBe(UNPLACED_FAILURE_MESSAGE);
	});
});

describe("the draft", () => {
	it("is not written until the user changes something", async () => {
		await mountPool();
		await pastTheWriteDelay();
		expect(window.sessionStorage.length).toBe(0);
	});

	it("is written after a pause, with the listed fields only and the step", async () => {
		const { wizard } = await mountPool();
		act(() => wizard().form.setValue("provider", "aws"));
		act(() => wizard().form.setValue("note", "kept out of the draft"));
		expect(storedPoolDraft()).toBeNull();
		await pastTheWriteDelay();
		expect(storedPoolDraft()).toEqual({
			v: 1,
			step: "cloud",
			at: NOW,
			values: { provider: "aws", region: "", min: 1, surge: "1" },
		});
		expect(window.sessionStorage.getItem(POOL_KEY)).not.toContain("kept out of the draft");
	});

	it("is written at once when the step changes", async () => {
		const { wizard } = await mountPool(FILLED);
		await act(async () => {
			await wizard().next();
		});
		expect(storedPoolDraft()).toMatchObject({ step: "placement", values: { provider: "aws" } });
	});

	it("is restored on mount: values, the step it was on, and the notice flag", async () => {
		writeDraft({ id: "example-pool", viewerId: VIEWER, scope: SCOPE }, draftOfPool(), FILLED, "capacity", NOW);
		const { wizard, calls, search } = await mountPool({ ...EXAMPLE_POOL_DEFAULTS, note: "typed default" });
		expect(wizard().restored).toBe(true);
		expect(wizard().form.getValues()).toEqual({ ...FILLED, note: "typed default" });
		expect(wizard().current.id).toBe("capacity");
		expect(calls).toEqual([{ via: "replace", patch: { step: "capacity" } }]);
		expect(search()).toBe("step=capacity");
	});

	it("restores values but lets the URL's step win over the draft's", async () => {
		writeDraft({ id: "example-pool", viewerId: VIEWER, scope: SCOPE }, draftOfPool(), FILLED, "capacity", NOW);
		const { wizard, calls } = await mountPool(EXAMPLE_POOL_DEFAULTS, { search: "step=placement" });
		expect(wizard().current.id).toBe("placement");
		expect(calls).toEqual([]);
	});

	it("is not restored for another viewer, and that viewer's copy is removed", async () => {
		writeDraft({ id: "example-pool", viewerId: VIEWER, scope: SCOPE }, draftOfPool(), FILLED, "capacity", NOW);
		const { wizard } = await mountPool(EXAMPLE_POOL_DEFAULTS, { viewerId: "user-2" });
		expect(wizard().restored).toBe(false);
		expect(wizard().form.getValues()).toEqual(EXAMPLE_POOL_DEFAULTS);
		expect(window.sessionStorage.length).toBe(0);
	});

	it("is not restored once it is older than the definition's TTL", async () => {
		writeDraft({ id: "example-pool", viewerId: VIEWER, scope: SCOPE }, draftOfPool(), FILLED, "capacity", NOW);
		const { wizard } = await mountPool(EXAMPLE_POOL_DEFAULTS, { now: NOW + 61 * 60_000 });
		expect(wizard().restored).toBe(false);
		expect(window.sessionStorage.length).toBe(0);
	});

	it("discard removes it, resets the values and returns to the first step without a history entry", async () => {
		writeDraft({ id: "example-pool", viewerId: VIEWER, scope: SCOPE }, draftOfPool(), FILLED, "capacity", NOW);
		const { wizard, calls, search } = await mountPool();
		act(() => wizard().discard());
		expect(window.sessionStorage.length).toBe(0);
		expect(wizard().restored).toBe(false);
		expect(wizard().form.getValues()).toEqual(EXAMPLE_POOL_DEFAULTS);
		expect(wizard().current.id).toBe("cloud");
		expect(calls.at(-1)).toEqual({ via: "replace", patch: { step: null } });
		expect(search()).toBe("");
		await pastTheWriteDelay();
		expect(window.sessionStorage.length).toBe(0);
	});

	it("complete removes it, clears the step, and nothing is written afterwards", async () => {
		const { wizard, calls, search } = await mountPool(FILLED, { search: "step=review&tab=x" });
		act(() => wizard().form.setValue("min", 3));
		act(() => wizard().complete());
		expect(calls.at(-1)).toEqual({ via: "replace", patch: { step: null } });
		expect(search()).toBe("tab=x");
		act(() => wizard().form.setValue("min", 4));
		await pastTheWriteDelay();
		expect(window.sessionStorage.length).toBe(0);
	});

	it("is flushed when the wizard unmounts with a write still scheduled", async () => {
		const { wizard, view } = await mountPool();
		act(() => wizard().form.setValue("provider", "gcp"));
		expect(storedPoolDraft()).toBeNull();
		view.unmount();
		expect(storedPoolDraft()).toMatchObject({ values: { provider: "gcp" } });
	});

	it("is neither read nor written when nobody is signed in", async () => {
		const { wizard } = await mountPool(EXAMPLE_POOL_DEFAULTS, { viewerId: null });
		act(() => wizard().form.setValue("provider", "aws"));
		await pastTheWriteDelay();
		expect(window.sessionStorage.length).toBe(0);
		expect(wizard().restored).toBe(false);
	});

	it("waits for the viewer before showing a step", async () => {
		writeDraft({ id: "example-pool", viewerId: VIEWER, scope: SCOPE }, draftOfPool(), FILLED, "capacity", NOW);
		const { view, wizard, calls } = await mountPool(EXAMPLE_POOL_DEFAULTS, { viewerId: undefined });
		await act(async () => {
			await Promise.resolve();
		});
		expect(wizard().ready).toBe(false);
		expect(calls).toEqual([]);
		view.rerender({ search: "", viewerId: VIEWER, now: NOW, calls });
		await waitFor(() => expect(wizard().ready).toBe(true));
		expect(wizard().restored).toBe(true);
		expect(wizard().current.id).toBe("capacity");
	});

	it("is never written for a wizard that declares `draft: null`", async () => {
		const { wizard } = await mount(orgWizard(async () => ({ kind: "not-started" })), ORG_DEFAULTS);
		act(() => wizard().form.setValue("name", "Globex"));
		await act(async () => {
			await wizard().next();
		});
		await pastTheWriteDelay();
		expect(window.sessionStorage.length).toBe(0);
	});
});

describe("an overlay wizard and its external step", () => {
	it("does not touch the URL while it is closed", async () => {
		const { wizard, calls } = await mount(importWizard, { repo: "", name: "" }, { search: "step=review" });
		expect(wizard().ready).toBe(true);
		expect(wizard().current.id).toBe("source");
		expect(calls).toEqual([]);
	});

	it("names the overlay in every step change, and keeps the params its step owns", async () => {
		const { wizard, calls, search } = await mount(
			importWizard,
			{ repo: "acme/infra", name: "" },
			{ search: "wizard=import&scan=abc&code=xyz" },
		);
		expect(wizard().current.id).toBe("source");
		await act(async () => {
			await wizard().next();
		});
		expect(calls).toEqual([{ via: "push", patch: { wizard: "import", step: "review" } }]);
		expect(search()).toBe("wizard=import&scan=abc&code=xyz&step=review");
		expect(wizard().current.id).toBe("review");
	});

	it("complete closes the overlay and removes the params its steps owned", async () => {
		const { wizard, calls, search } = await mount(
			importWizard,
			{ repo: "acme/infra", name: "infra" },
			{ search: "tab=x&wizard=import&step=review&scan=abc&code=xyz" },
		);
		act(() => wizard().complete());
		expect(calls).toEqual([
			{ via: "replace", patch: { step: null, wizard: null, scan: null, code: null } },
		]);
		expect(search()).toBe("tab=x");
	});

	it("discard keeps the overlay open and removes the params its steps owned", async () => {
		const { wizard, search } = await mount(
			importWizard,
			{ repo: "acme/infra", name: "infra" },
			{ search: "wizard=import&step=review&scan=abc" },
		);
		act(() => wizard().discard());
		expect(search()).toBe("wizard=import");
		expect(wizard().current.id).toBe("source");
	});

	it("resumes a reopened overlay on the step the user last moved to", async () => {
		const { wizard, view, calls } = await mount(
			importWizard,
			{ repo: "acme/infra", name: "" },
			{ search: "wizard=import" },
		);
		await act(async () => {
			await wizard().next();
		});
		expect(wizard().current.id).toBe("review");
		view.unmount();
		const reopened = await mount(importWizard, { repo: "", name: "" }, { search: "wizard=import" });
		expect(reopened.wizard().restored).toBe(true);
		expect(reopened.wizard().current.id).toBe("review");
		expect(reopened.calls).toEqual([{ via: "replace", patch: { wizard: "import", step: "review" } }]);
		expect(calls).toHaveLength(1);
	});
});

describe("a step that cannot be repeated", () => {
	it("asks the server before showing a step, and the URL cannot pass a step it has not settled", async () => {
		const settle = vi.fn(async (): Promise<Settlement> => ({ kind: "not-started" }));
		const { wizard, calls } = await mount(orgWizard(settle), ORG_DEFAULTS, { search: "step=invite" });
		expect(settle).toHaveBeenCalledTimes(1);
		expect(wizard().settlement).toEqual({ kind: "not-started" });
		expect(wizard().current.id).toBe("pay");
		expect(calls).toEqual([{ via: "replace", patch: { step: "pay" } }]);
		act(() => wizard().goTo("invite"));
		expect(wizard().current.id).toBe("pay");
	});

	it("next from that step asks again, and stays while it is not started", async () => {
		const settle = vi.fn(async (): Promise<Settlement> => ({ kind: "not-started" }));
		const { wizard, calls } = await mount(orgWizard(settle), { name: "Acme", seats: 0 }, { search: "step=pay" });
		await act(async () => {
			await wizard().next();
		});
		expect(settle).toHaveBeenCalledTimes(2);
		expect(wizard().current.id).toBe("pay");
		expect(wizard().form.getFieldState("seats").error?.message).toBe("At least one seat");
		expect(calls).toEqual([]);
	});

	it("next moves on once the server says it is done", async () => {
		const answers: Settlement[] = [{ kind: "not-started" }, { kind: "done", continueAt: "invite" }];
		const settle = vi.fn(async (): Promise<Settlement> => answers.shift() ?? { kind: "not-started" });
		const { wizard, calls } = await mount(orgWizard(settle), ORG_DEFAULTS, { search: "step=pay" });
		await act(async () => {
			await wizard().next();
		});
		expect(calls).toEqual([{ via: "push", patch: { step: "invite" } }]);
		expect(wizard().current.id).toBe("invite");
		expect(wizard().settlement).toEqual({ kind: "done", continueAt: "invite" });
	});

	it("starts past a step that is already done, and Back cannot return to it", async () => {
		const settle = async (): Promise<Settlement> => ({ kind: "done", continueAt: "invite" });
		const { wizard, calls } = await mount(orgWizard(settle), ORG_DEFAULTS, { search: "step=pay" });
		expect(wizard().current.id).toBe("invite");
		expect(calls).toEqual([{ via: "replace", patch: { step: "invite" } }]);
		act(() => wizard().back());
		act(() => wizard().goTo("pay"));
		expect(wizard().current.id).toBe("invite");
		expect(calls).toHaveLength(1);
	});

	it("leaves for the path a done step names, without showing a step", async () => {
		const settle = async (): Promise<Settlement> => ({ kind: "done", continueAt: "/acme/~/new" });
		const calls: LocationCall[] = [];
		const { wizard } = await mount(orgWizard(settle), ORG_DEFAULTS, { calls, viewerId: undefined });
		await waitFor(() => expect(calls).toEqual([{ via: "leave", path: "/acme/~/new" }]));
		expect(wizard().ready).toBe(false);
	});

	it("while it is in flight: nothing that could repeat it runs, and leaving asks first", async () => {
		const inFlight: Settlement = { kind: "in-flight", message: "Confirming your payment" };
		const settle = vi.fn(async (): Promise<Settlement> => inFlight);
		const { wizard, calls, onSubmit, view } = await mount(orgWizard(settle), ORG_DEFAULTS, {
			search: "step=pay",
		});
		expect(wizard().settlement).toEqual(inFlight);
		await act(async () => {
			await wizard().submit();
		});
		act(() => wizard().back());
		act(() => wizard().goTo("name"));
		expect(onSubmit).not.toHaveBeenCalled();
		expect(calls).toEqual([]);

		const leaving = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(leaving);
		expect(leaving.defaultPrevented).toBe(true);

		view.unmount();
		const after = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(after);
		expect(after.defaultPrevented).toBe(false);
	});

	it("a later next re-asks an in-flight step and moves on when it has settled", async () => {
		const answers: Settlement[] = [
			{ kind: "in-flight", message: "Confirming your payment" },
			{ kind: "in-flight", message: "Confirming your payment" },
			{ kind: "done", continueAt: "invite" },
		];
		const settle = vi.fn(async (): Promise<Settlement> => answers.shift() ?? { kind: "not-started" });
		const { wizard, calls } = await mount(orgWizard(settle), ORG_DEFAULTS, { search: "step=pay" });
		await act(async () => {
			await wizard().next();
		});
		expect(calls).toEqual([]);
		await act(async () => {
			await wizard().next();
		});
		expect(calls).toEqual([{ via: "push", patch: { step: "invite" } }]);
	});

	it("reads a check that fails as unknown: it says so, and does not submit", async () => {
		const settle = vi.fn((): Promise<Settlement> => Promise.reject(new Error("network")));
		const { wizard, onSubmit } = await mount(orgWizard(settle), ORG_DEFAULTS, { search: "step=invite" });
		expect(wizard().settlement).toEqual({ kind: "unknown", message: SETTLE_FAILED_MESSAGE });
		expect(wizard().current.id).toBe("pay");
		await act(async () => {
			await wizard().submit();
		});
		expect(onSubmit).not.toHaveBeenCalled();
		const leaving = new Event("beforeunload", { cancelable: true });
		window.dispatchEvent(leaving);
		expect(leaving.defaultPrevented).toBe(false);
	});

	it("a stopped step still lets the user go back and change something", async () => {
		const stopped: Settlement = { kind: "stopped", message: "The payment did not go through" };
		const { wizard, calls } = await mount(orgWizard(async () => stopped), ORG_DEFAULTS, { search: "step=pay" });
		expect(wizard().settlement).toEqual(stopped);
		act(() => wizard().back());
		expect(calls).toEqual([{ via: "push", patch: { step: "name" } }]);
	});

	it("leaves from next when the step settles to a path", async () => {
		const answers: Settlement[] = [{ kind: "not-started" }, { kind: "done", continueAt: "/acme" }];
		const settle = vi.fn(async (): Promise<Settlement> => answers.shift() ?? { kind: "not-started" });
		const { wizard, calls } = await mount(orgWizard(settle), ORG_DEFAULTS, { search: "step=pay" });
		await act(async () => {
			await wizard().next();
		});
		expect(calls).toEqual([{ via: "leave", path: "/acme" }]);
	});
});

describe("a wizard that shows no step", () => {
	it("throws rather than render nothing", () => {
		const definition = defineWizard<ImportValues, ImportValues>({
			id: "hidden",
			presentation: "page",
			schema: z.object({ repo: z.string(), name: z.string() }),
			steps: [
				{
					id: "only",
					label: "Only",
					fields: ["repo", "name"],
					schema: z.object({}),
					when: () => false,
				},
			],
			draft: null,
		});
		const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => renderHook(() => useHarness(definition, { defaultValues: { repo: "", name: "" }, scope: SCOPE, onSubmit: () => {} }, { search: "", viewerId: VIEWER, now: NOW, calls: [] }))).toThrow(/shows no step/);
		silenced.mockRestore();
	});
});

/** A small pool wizard on real inputs, with the capacity step's `surge` inside a disclosure. */
function PoolWizard({ onSubmit }: { onSubmit: (values: ExamplePoolValues) => void }) {
	const [search, setSearch] = useState("step=review");
	const move = (patch: Readonly<Record<string, string | null>>) =>
		setSearch((current) => applyParamPatch(current, patch));
	const wizard = useWizardEngine(
		examplePoolWizard,
		{ defaultValues: { ...FILLED, surge: "" }, scope: SCOPE, onSubmit },
		{
			location: {
				read: (name) => new URLSearchParams(search).get(name),
				push: move,
				replace: move,
				leave: () => {},
			},
			viewerId: null,
		},
	);
	const { register, formState } = wizard.form;
	if (!wizard.ready) return <p>Loading</p>;
	return (
		<form onSubmit={(event) => event.preventDefault()}>
			<Stepper label="Add a warm pool" items={wizard.items} onSelect={wizard.goTo} />
			<WizardFormError message={wizard.formError} />
			{wizard.current.id === "capacity" ? (
				<WizardDisclosure label="Advanced scaling" forceOpen={formState.errors.surge !== undefined}>
					<label>
						Rollout surge
						<input {...register("surge")} />
					</label>
					<p role="alert">{formState.errors.surge?.message}</p>
				</WizardDisclosure>
			) : null}
			{wizard.current.id === "review" ? (
				<label>
					Note
					<input {...register("note")} />
				</label>
			) : null}
			<WizardFooter
				back={wizard.stepNumber > 1 ? wizard.back : null}
				primary={
					wizard.isLast
						? { kind: "submit", label: "Create pool", onPress: () => void wizard.submit() }
						: { kind: "next", label: "Next", onPress: () => void wizard.next() }
				}
				pending={false}
			/>
		</form>
	);
}

describe("on real inputs", () => {
	it("a field that only fails on submit is shown, opened and focused — the button never does nothing", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(<PoolWizard onSubmit={onSubmit} />);
		await user.click(await screen.findByRole("button", { name: "Create pool" }));

		const surge = await screen.findByLabelText("Rollout surge");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Advanced scaling" })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("alert")).toHaveTextContent("At least 1");
		await waitFor(() => expect(surge).toHaveFocus());
		expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent("Capacity");

		await user.type(surge, "2");
		await user.click(screen.getByRole("button", { name: "Next" }));
		await user.click(await screen.findByRole("button", { name: "Create pool" }));
		expect(onSubmit).toHaveBeenCalledWith({ ...FILLED, surge: "2" });
	});
});

/** The example wizard's draft declaration. */
function draftOfPool() {
	const draft = examplePoolWizard.draft;
	if (draft === null) throw new Error("the example wizard keeps a draft");
	return draft;
}
