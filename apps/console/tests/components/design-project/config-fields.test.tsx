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

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigFields } from "@/components/design-project/canvas/inspector/config-fields";
import {
	getKindConfig,
	type KindConfig,
} from "@/components/design-project/canvas/inspector/config-schema";
import { nodeReadiness } from "@/lib/canvas/node-status";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

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

describe("ConfigFields — readiness cannot lag the buffer", () => {
	/** A canvas holding one project root and one NoSQL table, with the table's id. */
	function seedTable(): string {
		useCanvasStore.setState({ nodes: [], card: null });
		const id = useCanvasStore.getState().addNode("nosql");
		return id;
	}

	/** The table node's current config, straight from the store. */
	function tableConfig(id: string): Record<string, unknown> {
		const node = useCanvasStore.getState().nodes.find((n) => n.id === id);
		if (!node) throw new Error(`no node ${id}`);
		return node.data.config;
	}

	/** Readiness as the board and the card read it — from the store, never from the form. */
	function stateOf(id: string) {
		const s = useCanvasStore.getState();
		return nodeReadiness(s.nodes, s.getCoreIdentity(), id).state;
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
				onChange={(patch) => useCanvasStore.getState().updateNodeConfig(id, patch)}
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
					onChange={(patch) => useCanvasStore.getState().updateNodeConfig(id, patch)}
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
