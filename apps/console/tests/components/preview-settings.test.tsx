// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSettings } from "@/components/settings/preview/preview-settings";

const { configurePreviewEnvironments } = vi.hoisted(() => ({
	configurePreviewEnvironments: vi.fn(),
}));

vi.mock("@/app/server/actions/preview", () => ({
	configurePreviewEnvironments: (projectId: string, values: unknown) =>
		configurePreviewEnvironments(projectId, values),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
}));

const { toast } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

vi.mock("@/components/repository-selector", () => ({
	RepositorySelector: ({
		value,
		onChange,
		onRepositorySelect,
	}: {
		value: string;
		onChange: (value: string) => void;
		onRepositorySelect?: (repo: {
			id: string;
			name: string;
			full_name: string;
			url: string;
			private: boolean;
			default_branch: string;
			provider: "github";
		}) => void;
	}) => (
		<div>
			<input
				aria-label="Preview repository"
				value={value}
				onChange={(event) => onChange(event.target.value)}
			/>
			<button
				type="button"
				onClick={() =>
					onRepositorySelect?.({
						id: "repo-1",
						name: "shop",
						full_name: "acme/shop",
						url: "https://github.com/acme/shop",
						private: true,
						default_branch: "main",
						provider: "github",
					})
				}
			>
				Select repo
			</button>
		</div>
	),
}));

const FABRICS = [
	{ id: "11111111-1111-4111-8111-111111111111", name: "shared", region: "eu-west-1", status: "ACTIVE" },
] as const;
const CREDS = [
	{ id: "22222222-2222-4222-8222-222222222222", purpose: "argocd", method: "oauth" },
	{ id: "33333333-3333-4333-8333-333333333333", purpose: "applications", method: "pat" },
] as const;

function renderPanel(initialConfig = null) {
	return render(
		<PreviewSettings
			projectId="proj-1"
			initialConfig={initialConfig}
			fabrics={[...FABRICS]}
			gitCredentials={[...CREDS]}
			gitlabBaseUrl="https://gitlab.com"
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	configurePreviewEnvironments.mockResolvedValue({
		config: {
			enabled: true,
			git_provider: "github",
			repo_owner: "acme",
			repo_name: "shop",
			apps_path: ".",
			placement_mode: "namespace",
			namespace_prefix: "preview",
			fabric_id: null,
			git_credential_id: null,
		},
	});
});

describe("PreviewSettings", () => {
	it("blocks saving a blank configuration with schema validation", async () => {
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("switch", { name: /enable preview/i }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));
		expect(await screen.findByText(/too small/i)).toBeInTheDocument();
		expect(configurePreviewEnvironments).not.toHaveBeenCalled();
	});

	it("saves selected repository parts and enabled state through the form action", async () => {
		const user = userEvent.setup();
		renderPanel();
		await user.click(screen.getByRole("button", { name: "Select repo" }));
		await user.click(screen.getByRole("switch", { name: /enable preview/i }));
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		await waitFor(() => expect(configurePreviewEnvironments).toHaveBeenCalledTimes(1));
		expect(configurePreviewEnvironments).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({
				enabled: true,
				git_provider: "github",
				repo_owner: "acme",
				repo_name: "shop",
			}),
		);
		expect(toast.success).toHaveBeenCalled();
	});
});
