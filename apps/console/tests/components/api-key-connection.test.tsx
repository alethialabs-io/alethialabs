// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The api-key connect sheet's form (#6816). It ends on an OUTCOME with a primary Done: it used to
// close the moment the save returned, including when the provider had rejected the credential.
// A failure is shown once — under its field, or in the callout — and the submit cannot run twice.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ save: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn() }));

vi.mock("@/app/server/actions/connectors", () => ({ saveConnectorCredential: h.save }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc({}).orpc };
});
vi.mock("sonner", () => ({
	toast: { error: h.toastError, success: h.toastSuccess, warning: vi.fn(), info: vi.fn() },
}));

import { ApiKeyConnection } from "@/components/connectors/api-key-connection";
import type { ConnectorProviderMeta } from "@/lib/connectors/registry.generated";

/** A provider with one required secret field and one optional plain one. */
const provider: ConnectorProviderMeta = {
	category: "observability",
	slug: "acme-metrics",
	name: "Acme Metrics",
	description: "Ship metrics to Acme.",
	organization: "Acme",
	icon_url: null,
	status: "active",
	sort_order: 0,
	modulePath: "",
	credentialFields: [
		{ key: "api_key", label: "API Key", type: "password", secret: true, required: true },
		{ key: "site", label: "Site", type: "text", required: false },
	],
	providerConfigFields: [],
};

/** Renders the form under a fresh client. */
function renderForm(onDone = vi.fn()) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	rtlRender(
		<QueryClientProvider client={client}>
			<ApiKeyConnection provider={provider} onDone={onDone} />
		</QueryClientProvider>,
	);
	return onDone;
}

beforeEach(() => {
	h.save.mockReset();
	h.toastError.mockReset();
	h.toastSuccess.mockReset();
});

describe("ApiKeyConnection", () => {
	it("names a missing required field under it and sends nothing", async () => {
		const user = userEvent.setup();
		renderForm();

		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findByText("API Key is required.")).toBeInTheDocument();
		expect(h.save).not.toHaveBeenCalled();
	});

	it("ends on a verified outcome with Done, and closes only when Done is pressed", async () => {
		const user = userEvent.setup();
		h.save.mockResolvedValue({ ok: true, data: { verified: true } });
		const onDone = renderForm();

		await user.type(screen.getByLabelText(/^API Key/), "secret-value");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findByText("Connected and verified")).toBeInTheDocument();
		expect(h.save).toHaveBeenCalledWith({
			slug: "acme-metrics",
			fields: { api_key: "secret-value", site: "" },
		});
		expect(onDone).not.toHaveBeenCalled();
		// The outcome is on screen, so it is not also a toast.
		expect(h.toastSuccess).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Done" }));
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("stays open on a save the provider rejected, with its reason and a way back to the form", async () => {
		const user = userEvent.setup();
		h.save.mockResolvedValue({ ok: true, data: { verified: false, message: "401 from Acme" } });
		const onDone = renderForm();

		await user.type(screen.getByLabelText(/^API Key/), "wrong");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findByText("Saved, but not verified")).toBeInTheDocument();
		expect(screen.getByText(/401 from Acme/)).toBeInTheDocument();
		expect(onDone).not.toHaveBeenCalled();
		await user.click(screen.getByRole("button", { name: "Edit credential" }));
		expect(screen.getByLabelText(/^API Key/)).toBeInTheDocument();
	});

	it("puts the server's message for a field under that field, and shows it once", async () => {
		const user = userEvent.setup();
		h.save.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "Invalid input.",
				fields: { "fields.api_key": ["API Key is not in the expected format."] },
			},
		});
		renderForm();

		await user.type(screen.getByLabelText(/^API Key/), "x");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findAllByText("API Key is not in the expected format.")).toHaveLength(1);
		expect(h.toastError).not.toHaveBeenCalled();
	});

	it("shows a refusal in the callout and not also as a toast", async () => {
		const user = userEvent.setup();
		h.save.mockResolvedValue({
			ok: false,
			error: { kind: "forbidden", message: "Your role can't manage connectors." },
		});
		renderForm();

		await user.type(screen.getByLabelText(/^API Key/), "x");
		await user.click(screen.getByRole("button", { name: "Connect" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Your role can't manage connectors.");
		expect(h.toastError).not.toHaveBeenCalled();
	});

	it("sends once when Connect is pressed twice while the save is in flight", async () => {
		const user = userEvent.setup();
		let finish: (value: unknown) => void = () => {};
		h.save.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		renderForm();

		await user.type(screen.getByLabelText(/^API Key/), "secret-value");
		const connect = screen.getByRole("button", { name: "Connect" });
		await user.click(connect);
		await waitFor(() => expect(connect).toBeDisabled());
		await user.click(connect);
		expect(h.save).toHaveBeenCalledTimes(1);

		finish({ ok: true, data: { verified: true } });
		expect(await screen.findByText("Connected and verified")).toBeInTheDocument();
	});
});
