// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// L6b: `factura:issue-manual`. Without --issue it prints the proposed document and writes nothing;
// with --issue it issues. Input comes from flags or a JSON file, never both, and is validated before
// anything is looked up.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { put: vi.fn(), get: vi.fn() } }));

import { runIssueManualCli } from "@/lib/billing/factura/manual-cli";
import type { ManualDeps, ManualFacturaStore } from "@/lib/billing/factura/manual";
import type { Factura, FacturaInsert } from "@/lib/db/schema";

/** A memory store recording every issue call. */
function store() {
	const rows: Factura[] = [];
	const s: ManualFacturaStore & { rows: Factura[]; issues: number } = {
		rows,
		issues: 0,
		async findByManualKey(key) {
			return rows.find((r) => r.manualKey === key) ?? null;
		},
		async findByNumber(n) {
			return rows.find((r) => r.number === n) ?? null;
		},
		async issue(build: (n: string) => FacturaInsert) {
			s.issues++;
			const i = build(String(rows.length + 1).padStart(10, "0"));
			const row: Factura = {
				id: `f${rows.length + 1}`,
				organizationId: i.organizationId ?? null,
				source: i.source ?? "stripe",
				manualKey: i.manualKey ?? null,
				number: i.number,
				kind: i.kind,
				originalFacturaId: i.originalFacturaId ?? null,
				stripeInvoiceId: null,
				stripeRefundId: null,
				issueDate: i.issueDate,
				chargeableDate: i.chargeableDate,
				snapshot: i.snapshot,
				pdfKey: null,
				pdfSha256: null,
				createdAt: new Date(),
			};
			rows.push(row);
			return row;
		},
		async attachPdf(id, key, sha) {
			const row = rows.find((r) => r.id === id);
			if (row) Object.assign(row, { pdfKey: key, pdfSha256: sha });
		},
		async creditedBaseMinor() {
			return 0;
		},
	};
	return s;
}

/** CLI dependencies capturing output. */
function cli(files: Record<string, string> = {}) {
	const s = store();
	const out: string[] = [];
	const err: string[] = [];
	const manual: Partial<ManualDeps> = {
		store: s,
		pdfStorage: { put: async () => undefined, get: async () => null },
		rateLookup: async () => null,
		render: async () => new TextEncoder().encode("%PDF"),
		supplier: { vatRegistered: true, vatNumber: "BG208913663" },
		now: () => new Date(Date.UTC(2027, 0, 2, 10)),
	};
	return {
		s,
		out,
		err,
		deps: {
			readFile: async (p: string) => {
				const f = files[p];
				if (f === undefined) throw new Error(`ENOENT: ${p}`);
				return f;
			},
			out: (l: string) => out.push(l),
			err: (l: string) => err.push(l),
			manual,
		},
	};
}

const PADDLE_FLAGS = [
	"--key=paddle-market:2026-12",
	"--recipient-name=Paddle.com Market Ltd",
	"--recipient-address=Judd House, 18-29 Mora Street",
	"--recipient-city=London",
	"--recipient-postal-code=EC1V 8BT",
	"--recipient-country=GB",
	"--recipient-vat=GB123456789",
	"--chargeable-date=2026-12-31",
	"--description=Software services supplied via Paddle, December 2026",
	"--amount=1234.56",
	"--period-start=2026-12-01",
	"--period-end=2026-12-31",
];

describe("factura:issue-manual", () => {
	it("dry run by default: prints the proposed document, takes no number", async () => {
		const c = cli();
		expect(await runIssueManualCli(PADDLE_FLAGS, c.deps)).toBe(0);
		expect(c.s.issues).toBe(0);
		const printed = c.out.join("\n");
		expect(printed).toContain("ФАКТУРА / Invoice");
		expect(printed).toContain("(номер при издаване / assigned at issue)");
		expect(printed).toContain("чл. 21, ал. 2 ЗДДС");
		expect(printed).toContain("VAT treatment: outside_scope");
		expect(printed).toContain("dry run: nothing was issued");
		expect(printed).toContain("Readable by no organization (operator only)");
	});

	it("--issue issues it; a second --issue reports the existing number", async () => {
		const c = cli();
		expect(await runIssueManualCli([...PADDLE_FLAGS, "--issue"], c.deps)).toBe(0);
		expect(c.out).toEqual(["issued: фактура 0000000001", "pdf: manual/0000000001.pdf"]);
		expect(await runIssueManualCli([...PADDLE_FLAGS, "--issue"], c.deps)).toBe(0);
		expect(c.out[2]).toContain("already issued: фактура 0000000001");
		expect(c.s.issues).toBe(1);
		expect(await runIssueManualCli(PADDLE_FLAGS, c.deps)).toBe(0);
		expect(c.out.at(-1)).toContain("already issued as фактура 0000000001");
	});

	it("reads a JSON file, and a credit note from flags", async () => {
		const input = {
			key: "ent:bg:2027-01",
			recipient: { name: "Customer ЕООД", addressLine1: "ул. 1", city: "София", country: "BG", vatNumber: "BG123456789" },
			chargeableDate: "2027-01-01",
			lines: [{ description: "Alethia Enterprise", quantity: 1, unitAmount: "1000" }],
		};
		const c = cli({ "in.json": JSON.stringify(input) });
		expect(await runIssueManualCli(["--file=in.json", "--issue"], c.deps)).toBe(0);
		expect(c.s.rows[0].snapshot.vatMinor).toBe(20000);
		const cnFlags = ["--credit-note", "--key=ent:bg:2027-01:cn1", "--original=0000000001", "--amount=100", "--reason=Отстъпка / Discount", "--chargeable-date=2027-01-02"];
		expect(await runIssueManualCli(cnFlags, c.deps)).toBe(0);
		expect(c.out.join("\n")).toContain("КРЕДИТНО ИЗВЕСТИЕ / Credit note");
		expect(c.out.at(-1)).toContain("dry run: nothing was issued; re-run with --issue to issue this credit note");
		expect(await runIssueManualCli([...cnFlags, "--issue"], c.deps)).toBe(0);
		expect(c.out.at(-2)).toBe("issued: credit note 0000000002");
		expect(c.s.rows[1].snapshot).toMatchObject({ taxBaseMinor: -10000, vatMinor: -2000 });
	});

	it("rejects invalid input with each zod issue, before any lookup", async () => {
		const c = cli();
		const bad = PADDLE_FLAGS.filter((f) => !f.startsWith("--recipient-vat")).map((f) =>
			f.startsWith("--amount") ? "--amount=12.345" : f,
		);
		expect(await runIssueManualCli(bad, c.deps)).toBe(1);
		expect(c.err[0]).toBe("invalid фактура input:");
		expect(c.err.slice(1).join("\n")).toContain("recipient.vatNumber");
		expect(c.err.slice(1).join("\n")).toContain("lines.0.unitAmount");
		expect(c.s.issues).toBe(0);
		const cn = cli();
		expect(await runIssueManualCli(["--credit-note", "--key=k-1"], cn.deps)).toBe(1);
		expect(cn.err[0]).toBe("invalid credit-note input:");
	});

	it("prints refusals and exits 1", async () => {
		const c = cli();
		expect(await runIssueManualCli([...PADDLE_FLAGS, "--currency=USD", "--issue"], c.deps)).toBe(1);
		expect(c.err[0]).toMatch(/^refused \(no_rate\)/);
		expect(await runIssueManualCli([...PADDLE_FLAGS, "--currency=USD"], c.deps)).toBe(1);
		const cn = cli();
		expect(await runIssueManualCli(["--credit-note", "--key=k-12", "--original=0000000009", "--reason=abc", "--chargeable-date=2027-01-01"], cn.deps)).toBe(1);
		expect(cn.err[0]).toMatch(/^refused \(no_original\)/);
	});

	it("usage errors: no arguments, a stray argument, --file mixed with flags; unreadable file", async () => {
		const c = cli();
		expect(await runIssueManualCli([], c.deps)).toBe(2);
		expect(await runIssueManualCli(["stray"], c.deps)).toBe(2);
		expect(await runIssueManualCli(["--file=in.json", "--key=x"], c.deps)).toBe(2);
		expect(c.err.at(-1)).toContain("--file cannot be combined with input flags (--key)");
		expect(await runIssueManualCli(["--file=missing.json"], c.deps)).toBe(1);
		expect(c.err.at(-1)).toContain("missing.json is not a readable JSON file");
	});

	it("warns on stderr when issued late", async () => {
		const c = cli();
		c.deps.manual.now = () => new Date(Date.UTC(2027, 0, 12, 10));
		expect(await runIssueManualCli([...PADDLE_FLAGS, "--issue"], c.deps)).toBe(0);
		expect(c.err).toEqual(["warning: issued 12 days after the chargeable event; Art. 113(4) ЗДДС asks for 5"]);
	});
});
