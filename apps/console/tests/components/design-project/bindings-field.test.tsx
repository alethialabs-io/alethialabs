// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Render guard for the BYO-IaC facet→output picker in the service bind editor (#823). The picker is
// the UI half of #687: when a service binds to a BYO-IaC resource (a target with a Terraform
// `address`), each injected facet must be mapped to one of the customer module's outputs. It appears
// ONLY for a service (enableIacTargets) bound to a BYO-IaC target — never for a chart workload, whose
// backend lane resolves no output_keys.

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BindingsField,
	bindingFacets,
	type ServiceBinding,
} from "@/components/design-project/canvas/inspector/bindings-field";
import type { IacGroup } from "@/lib/canvas/iac-inventory";
import { board } from "@/lib/canvas/store/board";
import { iacNodes } from "@/lib/canvas/store/out-of-band";
import { withBoardSources } from "@/tests/fixtures/canvas/board";

/** A scanned BYO-IaC module with one database resource + two outputs, as the status read carries it. */
const DB_GROUP: IacGroup = {
	key: "database|module.db",
	kind: "database",
	module: "module.db",
	source: "scan",
	members: [
		{
			address: "module.db.aws_db_instance.main",
			type: "aws_db_instance",
			name: "main",
			module: "module.db",
		},
	],
};
const OUTPUTS = ["db_endpoint", "db_master_secret"];

/** A binding already pointed at the BYO-IaC db, injecting one non-secret + one credential facet. */
const byoBinding: ServiceBinding = {
	target: {
		kind: "database",
		name: "main",
		address: "module.db.aws_db_instance.main",
		output_keys: {},
	},
	inject: [
		{ env: "DATABASE_HOST", from: "endpoint" },
		{ env: "DATABASE_PASSWORD", from: "password" },
	],
};

/** The module's cards and outputs on the board, as the canvas hands them from the status read. */
const IAC_CARDS = iacNodes([DB_GROUP]);

/** Render `ui` with the module's cards and output names on the board. */
function renderOnBoard(ui: ReactNode) {
	return render(withBoardSources(ui, { others: IAC_CARDS, iacOutputs: OUTPUTS }));
}

beforeEach(() => {
	board.reset();
});

describe("BindingsField — BYO-IaC facet→output picker (#823)", () => {
	it("shows the facet→output mapping for a service bound to a BYO-IaC target", () => {
		renderOnBoard(
			<BindingsField enableIacTargets value={[byoBinding]} onChange={vi.fn()} />,
		);
		// The mapping block + the credential row (its label is unique to the picker; "endpoint"
		// would collide with the inject-row facet Select, so assert the unambiguous ones).
		expect(screen.getByText("Map to module outputs")).toBeInTheDocument();
		expect(screen.getByText("credential secret")).toBeInTheDocument();
		// The security guardrail is spelled out on the credential row.
		expect(
			screen.getByText(/name \/ ARN\), not the value/i),
		).toBeInTheDocument();
	});

	it("does NOT show the picker for a first-class target (no address)", () => {
		const firstClass: ServiceBinding = {
			target: { kind: "database", name: "orders-db" },
			inject: [{ env: "DATABASE_HOST", from: "endpoint" }],
		};
		renderOnBoard(
			<BindingsField enableIacTargets value={[firstClass]} onChange={vi.fn()} />,
		);
		expect(screen.queryByText("Map to module outputs")).not.toBeInTheDocument();
	});

	it("does NOT show the picker when the context opts out (chart-workload safety)", () => {
		// enableIacTargets omitted → even a BYO-IaC target gets no output picker, because the
		// chart-workload lane does not resolve output_keys.
		renderOnBoard(<BindingsField value={[byoBinding]} onChange={vi.fn()} />);
		expect(screen.queryByText("Map to module outputs")).not.toBeInTheDocument();
	});
});

// #6467 — the `database` facet is resolved by the BYO chart lane only (generate.go's service lane
// has no case for it), so the editor offers it only where the chart-workload panel asks for it.
describe("BindingsField — the database facet is chart-workload only (#6467)", () => {
	const dbName: ServiceBinding = {
		target: { kind: "database", name: "orders-db" },
		inject: [{ env: "DATABASE_NAME", from: "database" }],
	};

	it("offers `database` only when allowDatabaseFacet is set", () => {
		expect(bindingFacets(true).map((f) => f.value)).toContain("database");
		expect(bindingFacets(false).map((f) => f.value)).not.toContain("database");
		expect(bindingFacets(true).find((f) => f.value === "database")?.secret).toBe(false);
	});

	it("the chart-workload editor lists it", () => {
		renderOnBoard(<BindingsField allowDatabaseFacet value={[dbName]} onChange={vi.fn()} />);
		expect(screen.getByText("database name")).toBeInTheDocument();
	});

	it("the service editor does not", () => {
		renderOnBoard(<BindingsField enableIacTargets value={[dbName]} onChange={vi.fn()} />);
		expect(screen.queryByText("database name")).not.toBeInTheDocument();
	});
});
