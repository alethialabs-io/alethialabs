// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the reply composer's Send follows the body it watches: disabled while the body is empty or
// whitespace, enabled once it holds text. The composer reads the body through `useWatch`, so this
// pins that every keystroke still re-renders the button.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { queryWrapper } from "@/tests/helpers/query-wrapper";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/support", () => ({ postCaseMessage: vi.fn() }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});

import { CaseComposer } from "@/components/support/cases/case-composer";

describe("CaseComposer — Send follows the watched body", () => {
	it("is disabled for an empty or blank body and enabled once the body has text", async () => {
		const user = userEvent.setup();
		render(<CaseComposer caseId="c1" />, { wrapper: queryWrapper() });
		const send = screen.getByRole("button", { name: /Send/ });
		expect(send).toBeDisabled();

		const reply = screen.getByRole("textbox", { name: "Reply" });
		await user.type(reply, "   ");
		expect(send).toBeDisabled();

		await user.type(reply, "The deploy is stuck");
		expect(send).toBeEnabled();

		await user.clear(reply);
		expect(send).toBeDisabled();
	});
});
