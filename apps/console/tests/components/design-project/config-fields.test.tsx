// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The card's editing buffer. Every control used to write to the canvas store on each keystroke —
// through two whole-graph normalizers, an edge re-derive and a draft re-serialise — and two of the
// defects that made these cards hard to work were symptoms of it. A half-typed value now lives in
// the card and reaches the store once, on blur.
//
// The number semantics are the load-bearing part: an OPTIONAL (nullable-column) field commits NULL
// when cleared — "use the default" — because 0 trips the zod min(1) bound on the sizing columns; a
// REQUIRED one commits nothing at all and restores what was there, because 0 is a value the user
// did not type and it fights them the moment they backspace to retype.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import {
	getKindConfig,
	type KindConfig,
} from "@/components/design-project/canvas/inspector/config-schema";
import { nodeReadiness } from "@/lib/canvas/node-status";
import { board } from "@/lib/canvas/store/board";
import { coreIdentity } from "@/lib/canvas/store/derive";
import { boardNodes, setBoardNodes } from "@/tests/fixtures/canvas/board";
import { useInspectorPrefsStore } from "@/lib/stores/use-inspector-prefs-store";

const SCHEMA: KindConfig = {
	sections: [
		{
			id: "sizing",
			title: "Sizing",
			defaultOpen: true,
			fields: [
				{
					key: "storage_gb",
					type: "number",
					label: "Storage",
					min: 1,
					max: 1024,
					optional: true,
				},
				{ key: "count", type: "number", label: "Count", min: 1, max: 10 },
				{ key: "label", type: "text", label: "Label" },
			],
		},
	],
	summary: () => "",
};

/** Renders the schema and returns the two number inputs. */
function renderFields(onChange: (patch: Record<string, unknown>) => void) {
	render(
		<ConfigFields
			schema={SCHEMA}
			config={{ storage_gb: 32, count: 2, label: "db" }}
			provider="hetzner"
			onChange={onChange}
		/>,
	);
	return screen.getAllByRole("spinbutton");
}

describe("ConfigFields — the buffer commits on blur, not on keystroke", () => {
	it("typing writes nothing until the field is left", () => {
		const onChange = vi.fn();
		const [storage] = renderFields(onChange);

		fireEvent.change(storage, { target: { value: "6" } });
		fireEvent.change(storage, { target: { value: "64" } });
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.blur(storage);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({ storage_gb: 64 });
	});

	it("a text field buffers too, and commits the whole word once", () => {
		const onChange = vi.fn();
		renderFields(onChange);
		const label = screen.getByRole("textbox");

		fireEvent.change(label, { target: { value: "orders" } });
		expect(onChange).not.toHaveBeenCalled();

		fireEvent.blur(label);
		expect(onChange).toHaveBeenCalledWith({ label: "orders" });
	});

	it("shows what you type while you type it, empty string included", () => {
		const [storage] = renderFields(vi.fn());
		fireEvent.change(storage, { target: { value: "" } });
		expect(storage).toHaveValue(null);
	});
});

describe("ConfigFields — number fields", () => {
	it("commits NULL when an optional number field is cleared", () => {
		const onChange = vi.fn();
		const [storage] = renderFields(onChange);

		fireEvent.change(storage, { target: { value: "" } });
		fireEvent.blur(storage);

		expect(onChange).toHaveBeenCalledWith({ storage_gb: null });
	});

	it("NEVER writes 0 when a required number field is cleared", () => {
		const onChange = vi.fn();
		const [, count] = renderFields(onChange);

		fireEvent.change(count, { target: { value: "" } });
		fireEvent.blur(count);

		expect(onChange).not.toHaveBeenCalled();
		// …and the field shows what is still stored, rather than a 0 nobody typed.
		expect(count).toHaveValue(2);
	});

	it("clearing and retyping a required field commits only the new value", () => {
		const onChange = vi.fn();
		const [, count] = renderFields(onChange);

		fireEvent.change(count, { target: { value: "" } });
		fireEvent.change(count, { target: { value: "7" } });
		fireEvent.blur(count);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({ count: 7 });
	});

	it("renders a NULL value as an empty input (placeholder territory)", () => {
		render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: null, count: 2 }}
				provider="hetzner"
				onChange={vi.fn()}
			/>,
		);
		const [storage] = screen.getAllByRole("spinbutton");
		expect(storage).toHaveValue(null);
	});
});

// ── #4445 — the buffer defers the WRITE, never the TRUTH ─────────────────────────────────────────
//
// A node's readiness ("Needs setup" on the board, the status strip on its card) is derived by
// `nodeReadiness` from the STORE. While a cleared required field sat only in the buffer, the card
// went on saying the design was deployable over a config the deploy would reject — and the inline
// error two inches below it, which already read the buffer, said the opposite.
//
// These tests drive the REAL nosql schema through the REAL store and ask the REAL readiness
// function, rather than asserting that `onChange` fired: `onChange` firing is the mechanism, and the
// thing the gate spec asserts — and the thing a user acts on — is the state the card ends up in.
// They are the browser-free proof of `architecture-canvas.spec.ts`'s "a card goes Needs-setup the
// moment its config stops being deployable", whose own subject is `fill("")`, i.e. no blur.

/** A canvas holding one project root and one NoSQL table, with the table's id. */
function seedTable(): string {
	setBoardNodes([]);
	board.view.getState().openCard(null);
	const id = board.addNode("nosql");
	return id;
}

/** The table node's current config, straight from the store. */
function tableConfig(id: string): Record<string, unknown> {
	const node = boardNodes().find((n) => n.id === id);
	if (!node) throw new Error(`no node ${id}`);
	return node.data.config;
}

describe("ConfigFields — readiness cannot lag the buffer", () => {
	// A fresh table is valid, so on first view its Schema group is collapsed (#6837). These tests are
	// about the buffer, not the disclosure, so the person has Schema open — the remembered choice.
	beforeEach(() => {
		useInspectorPrefsStore.setState({ openSections: { "nosql:schema": true }, tab: {} });
	});

	/** Readiness as the board and the card read it — from the store, never from the form. */
	function stateOf(id: string) {
		const designNodes = board.document.getState().designNodes;
		return nodeReadiness(designNodes, coreIdentity(designNodes), id).state;
	}

	/** Renders the table's real Settings body, wired to the store the way the inspector wires it. */
	function renderTable(id: string) {
		const schema = getKindConfig("nosql");
		if (!schema) throw new Error("nosql has no config schema");
		const view = render(
			<ConfigFields
				schema={schema}
				config={tableConfig(id)}
				provider="aws"
				kind="nosql"
				onChange={(patch) => board.document.getState().updateNodeConfig(id, patch)}
			/>,
		);
		// The card is re-rendered from the store on every commit, as the inspector does — otherwise
		// the buffer would go on comparing itself against the config it was first handed.
		return () =>
			view.rerender(
				<ConfigFields
					schema={schema}
					config={tableConfig(id)}
					provider="aws"
					kind="nosql"
					onChange={(patch) => board.document.getState().updateNodeConfig(id, patch)}
				/>,
			);
	}

	it("a freshly added table is ready — it defaults its partition key", () => {
		const id = seedTable();
		expect(stateOf(id)).toBe("ready");
	});

	it("clearing a required text field flips the node WITHOUT a blur", () => {
		const id = seedTable();
		renderTable(id);

		fireEvent.change(screen.getByLabelText("Partition key"), {
			target: { value: "" },
		});

		expect(tableConfig(id).partition_key).toBe("");
		expect(stateOf(id)).toBe("needs-setup");
	});

	it("the first character that makes it valid again flips it back, also without a blur", () => {
		const id = seedTable();
		const rerender = renderTable(id);

		fireEvent.change(screen.getByLabelText("Partition key"), {
			target: { value: "" },
		});
		// Asserted, not assumed: without this the test would read "ready" at the end because the
		// clear never reached the store, and would pass on exactly the defect it is here to catch.
		expect(stateOf(id)).toBe("needs-setup");

		rerender();
		fireEvent.change(screen.getByLabelText("Partition key"), {
			target: { value: "p" },
		});

		expect(tableConfig(id).partition_key).toBe("p");
		expect(stateOf(id)).toBe("ready");
	});

	// The BOUND, asserted rather than described. #4256 built two deliberate withholdings that a
	// blanket commit-on-invalid would delete: `flushNumber` RESTORES a required number the user
	// emptied (writing 0 both trips the min(1) bounds and fights a backspace), and `flush` DROPS a
	// list's blank rows on the way out. Both of those intermediate states are states the schema
	// rejects, so the rule is scoped to `text` — and this is the test that fails if that scope is
	// widened. Same key, same validity transition, declared as a number: withheld.
	it("the same clear on a NUMBER field is still withheld — the bound is the field type", () => {
		const id = seedTable();
		const real = getKindConfig("nosql");
		if (!real) throw new Error("nosql has no config schema");
		const asNumber: KindConfig = {
			...real,
			sections: [
				{
					id: "schema",
					title: "Schema",
					defaultOpen: true,
					fields: [{ key: "partition_key", type: "number", label: "Partition key" }],
				},
			],
		};
		const onChange = vi.fn();
		render(
			<ConfigFields
				schema={asNumber}
				config={tableConfig(id)}
				provider="aws"
				kind="nosql"
				onChange={onChange}
			/>,
		);

		fireEvent.change(screen.getByLabelText("Partition key"), {
			target: { value: "" },
		});

		expect(onChange).not.toHaveBeenCalled();
		expect(stateOf(id)).toBe("ready");
	});

	it("keystrokes that change nothing about validity still cost no store write", () => {
		const id = seedTable();
		const schema = getKindConfig("nosql");
		if (!schema) throw new Error("nosql has no config schema");
		const onChange = vi.fn();
		render(
			<ConfigFields
				schema={schema}
				config={tableConfig(id)}
				provider="aws"
				kind="nosql"
				onChange={onChange}
			/>,
		);

		// "u" → "us" → "use" — valid throughout, so this is the case the buffer exists for and the
		// early commit must stay out of.
		const key = screen.getByLabelText("Partition key");
		fireEvent.change(key, { target: { value: "u" } });
		fireEvent.change(key, { target: { value: "us" } });
		fireEvent.change(key, { target: { value: "use" } });

		expect(onChange).not.toHaveBeenCalled();
	});
});

// ── #6837 — a buffer flushes on every way out, not only on blur ──────────────────────────────────
//
// The inspector has no Save button: a value typed into it reaches the design on blur. These pin the
// two exits that are not a blur — the card unmounting under the caret, and the rail handing the same
// card another node's config — so nothing typed is ever silently dropped.

describe("ConfigFields — leaving without a blur", () => {
	it("type, unmount: the store holds the value", () => {
		useInspectorPrefsStore.setState({ openSections: { "nosql:schema": true }, tab: {} });
		const id = seedTable();
		const schema = getKindConfig("nosql");
		if (!schema) throw new Error("nosql has no config schema");
		const view = render(
			<ConfigFields
				schema={schema}
				config={tableConfig(id)}
				provider="aws"
				kind="nosql"
				onChange={(patch) => board.document.getState().updateNodeConfig(id, patch)}
			/>,
		);

		// Valid throughout, so no early commit: the value lives only in the buffer.
		fireEvent.change(screen.getByLabelText("Partition key"), { target: { value: "order_id" } });
		expect(tableConfig(id).partition_key).not.toBe("order_id");

		view.unmount();
		expect(tableConfig(id).partition_key).toBe("order_id");
	});

	it("a half-typed number is committed on unmount by the blur rules", () => {
		const onChange = vi.fn();
		const view = render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={onChange}
			/>,
		);
		const [storage] = screen.getAllByRole("spinbutton");
		fireEvent.change(storage, { target: { value: "64" } });
		expect(onChange).not.toHaveBeenCalled();

		view.unmount();
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({ storage_gb: 64 });
	});

	it("a cleared REQUIRED number is still withheld on unmount, never written as 0", () => {
		const onChange = vi.fn();
		const view = render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={onChange}
			/>,
		);
		const [, count] = screen.getAllByRole("spinbutton");
		fireEvent.change(count, { target: { value: "" } });

		view.unmount();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("a field already committed by its blur is not committed again on unmount", () => {
		const onChange = vi.fn();
		const view = render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={onChange}
			/>,
		);
		const label = screen.getByRole("textbox");
		fireEvent.change(label, { target: { value: "orders" } });
		fireEvent.blur(label);

		view.unmount();
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("handed another node's config mid-edit, it commits the typed value to the node it was typed into", () => {
		const first = vi.fn();
		const second = vi.fn();
		const view = render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={first}
			/>,
		);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "orders" } });

		view.rerender(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 8, count: 1, label: "cache" }}
				provider="hetzner"
				onChange={second}
			/>,
		);

		expect(first).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledWith({ label: "orders" });
		expect(second).not.toHaveBeenCalled();
		// …and the card now shows the node it was handed.
		expect(screen.getByRole("textbox")).toHaveValue("cache");
	});

	it("an equal config rebuilt by the parent flushes nothing", () => {
		const onChange = vi.fn();
		const view = render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "orders" } });
		view.rerender(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={onChange}
			/>,
		);
		expect(onChange).not.toHaveBeenCalled();
	});
});

// ── #6837 — what is open on first view ───────────────────────────────────────────────────────────

describe("ConfigFields — only a group that needs you is open on first view", () => {
	beforeEach(() => {
		useInspectorPrefsStore.setState({ openSections: {}, tab: {} });
	});

	/** Renders the real NoSQL Settings body over `config`. */
	function renderTable(config: Record<string, unknown>) {
		const schema = getKindConfig("nosql");
		if (!schema) throw new Error("nosql has no config schema");
		return render(
			<ConfigFields
				schema={schema}
				config={config}
				provider="aws"
				kind="nosql"
				onChange={vi.fn()}
			/>,
		);
	}

	it("a node whose defaults all deploy opens with every group collapsed", () => {
		const id = seedTable();
		renderTable(tableConfig(id));

		expect(screen.getByRole("button", { name: /^Schema/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Capacity/ })).toBeInTheDocument();
		expect(screen.queryByLabelText("Partition key")).not.toBeInTheDocument();
		expect(screen.queryByRole("radiogroup", { name: "Capacity mode" })).not.toBeInTheDocument();
	});

	it("the group holding a field with no usable value is open, and only that group", () => {
		const id = seedTable();
		renderTable({ ...tableConfig(id), partition_key: "" });

		expect(screen.getByLabelText("Partition key")).toBeInTheDocument();
		expect(screen.queryByRole("radiogroup", { name: "Capacity mode" })).not.toBeInTheDocument();
	});

	it("fixing the field does not fold its group shut under the caret", () => {
		const id = seedTable();
		renderTable({ ...tableConfig(id), partition_key: "" });

		const key = screen.getByLabelText("Partition key");
		act(() => key.focus());
		fireEvent.change(key, { target: { value: "order_id" } });

		expect(screen.getByLabelText("Partition key")).toBeInTheDocument();
	});

	it("a group the person closed, forced open by an error, stays open while they fix it", () => {
		useInspectorPrefsStore.setState({ openSections: { "nosql:schema": false }, tab: {} });
		const id = seedTable();
		renderTable({ ...tableConfig(id), partition_key: "" });

		const key = screen.getByLabelText("Partition key");
		act(() => key.focus());
		fireEvent.change(key, { target: { value: "order_id" } });

		expect(screen.getByLabelText("Partition key")).toBeInTheDocument();
	});

	it("the person's own choice is remembered over the first-view rule", () => {
		useInspectorPrefsStore.setState({ openSections: { "nosql:capacity": true }, tab: {} });
		const id = seedTable();
		renderTable(tableConfig(id));

		expect(screen.getByRole("radiogroup", { name: "Capacity mode" })).toBeInTheDocument();
		expect(screen.queryByLabelText("Partition key")).not.toBeInTheDocument();
	});

	it("without a kind there is no validator to ask, so the schema's own defaultOpen stands", () => {
		renderFields(vi.fn());
		expect(screen.getByRole("textbox")).toBeInTheDocument();
	});
});

// ── #6837 — one column, and every field reachable by its key ────────────────────────────────────

describe("ConfigFields — a narrow rail", () => {
	it("lays its fields out in one column", () => {
		const { container } = render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={vi.fn()}
			/>,
		);
		const twoUp = Array.from(container.querySelectorAll("*")).filter((el) =>
			Array.from(el.classList).some((c) => /^(?:[a-z0-9]+:)*grid-cols-(?!1$)/.test(c)),
		);
		expect(twoUp.map((el) => el.className)).toEqual([]);
	});

	it("marks every field row with its key, and focusing a row puts the caret in its control", () => {
		const { container } = render(
			<ConfigFields
				schema={SCHEMA}
				config={{ storage_gb: 32, count: 2, label: "db" }}
				provider="hetzner"
				onChange={vi.fn()}
			/>,
		);
		const keys = Array.from(container.querySelectorAll("[data-field-key]")).map((el) =>
			el.getAttribute("data-field-key"),
		);
		expect(keys).toEqual(["storage_gb", "count", "label"]);

		const row = container.querySelector<HTMLElement>('[data-field-key="label"]');
		if (!row) throw new Error("no row for label");
		act(() => row.focus());
		expect(screen.getByRole("textbox")).toHaveFocus();
	});
});
