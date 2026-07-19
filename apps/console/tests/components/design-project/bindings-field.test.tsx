// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Render guard for the BYO-IaC facet→output picker in the service bind editor (#823). The picker is
// the UI half of #687: when a service binds to a BYO-IaC resource (a target with a Terraform
// `address`), each injected facet must be mapped to one of the customer module's outputs. It appears
// ONLY for a service (enableIacTargets) bound to a BYO-IaC target — never for a chart workload, whose
// backend lane resolves no output_keys.

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	BindingsField,
	type ServiceBinding,
} from "@/components/design-project/canvas/inspector/bindings-field";
import type { IacGroup } from "@/lib/canvas/iac-inventory";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** A scanned BYO-IaC module with one database resource + two outputs, as the store would hold it. */
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

beforeEach(() => {
	useCanvasStore.getState().reset();
	useCanvasStore.getState().setIacNodes([DB_GROUP]);
	useCanvasStore.getState().setIacOutputs(OUTPUTS);
});

describe("BindingsField — BYO-IaC facet→output picker (#823)", () => {
	it("shows the facet→output mapping for a service bound to a BYO-IaC target", () => {
		render(
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
		render(
			<BindingsField enableIacTargets value={[firstClass]} onChange={vi.fn()} />,
		);
		expect(screen.queryByText("Map to module outputs")).not.toBeInTheDocument();
	});

	it("does NOT show the picker when the context opts out (chart-workload safety)", () => {
		// enableIacTargets omitted → even a BYO-IaC target gets no output picker, because the
		// chart-workload lane does not resolve output_keys.
		render(<BindingsField value={[byoBinding]} onChange={vi.fn()} />);
		expect(screen.queryByText("Map to module outputs")).not.toBeInTheDocument();
	});
});
