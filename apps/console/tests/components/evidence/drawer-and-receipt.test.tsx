// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Two Evidence fixes (#6821, R6 C-30 / C-31):
//
//   · the detail drawer is a dialog WITH A NAME — the project — and a description, so it is not
//     announced as an unnamed dialog;
//   · a receipt is saved through the console's one `saveAsFile` (which attaches the link and revokes
//     the URL on the next task), under the job's short id, as the pretty-printed receipt.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EvidenceEnvRow } from "@/components/evidence/evidence-derive";
import type { SignedReceipt } from "@/types/jsonb.types";

const saveAsFile = vi.hoisted(() => vi.fn());
vi.mock("@/components/clusters/kubeconfig-download/flow", () => ({ saveAsFile }));

import { EvidenceDrawer } from "@/components/evidence/drawer/evidence-drawer";
import { downloadReceipt } from "@/components/evidence/receipt-download";

const row: EvidenceEnvRow = {
	projectId: "p1",
	projectName: "payments",
	projectSlug: "payments",
	environmentId: "e1",
	environmentName: "payments-prod",
	stage: "production",
	provider: "aws",
	region: "eu-west-1",
	verify: null,
	drift: null,
	security: null,
};

describe("the evidence drawer", () => {
	it("is a dialog named for the project, described by its environment", async () => {
		render(
			<EvidenceDrawer
				org="acme"
				row={row}
				waivers={[]}
				tab="drift"
				onTab={() => {}}
				onClose={() => {}}
				onDownload={() => {}}
			/>,
		);
		const dialog = await screen.findByRole("dialog", { name: "payments" });
		expect(dialog).toHaveAccessibleDescription(/payments-prod · eu-west-1/);
	});
});

/** A minimal signed receipt: a passing verdict with an empty report. */
const receipt: SignedReceipt = {
	algorithm: "ed25519",
	key_id: "test-key-1",
	signature: "deadbeef",
	receipt: {
		version: "1",
		plan_sha256: "a".repeat(64),
		catalog_version: "elench-controls-0.1.0",
		provider: "aws",
		verdict: "pass",
		report: {
			verdict: "pass",
			catalog_version: "elench-controls-0.1.0",
			provider: "aws",
			controls: [],
			summary: { pass: 0, fail: 0, warn: 0, not_evaluable: 0 },
		},
	},
};

describe("downloadReceipt", () => {
	it("saves the pretty-printed receipt under the job's short id, and returns the file name", () => {
		const name = downloadReceipt(receipt, "0123456789abcdef");
		expect(name).toBe("elench-receipt-01234567.json");
		expect(saveAsFile).toHaveBeenCalledWith(
			"elench-receipt-01234567.json",
			JSON.stringify(receipt, null, 2),
		);
	});

	it("lets a failed save throw, so nothing confirms a download that did not start", () => {
		saveAsFile.mockImplementationOnce(() => {
			throw new Error("blocked");
		});
		expect(() => downloadReceipt(receipt, "0123456789abcdef")).toThrow("blocked");
	});
});
