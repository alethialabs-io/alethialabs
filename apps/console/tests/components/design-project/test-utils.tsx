// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import React from "react";
import { render } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { projectFormSchema, type ProjectFormData, type ProjectFormInput } from "@/lib/validations/project-form.schema";


const DEFAULT_VALUES: ProjectFormData = {
	project: {
		project_name: "",
		environment_stage: "development",
		region: "",
		cloud_identity_id: "",
		iac_version: "1.11.4",
	},
	network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
	cluster: {
		cluster_version: "1.32",
		provider_config: { enable_karpenter: true },
		instance_types: ["t3.medium"],
		node_min_size: 2,
		node_max_size: 5,
		node_desired_size: 2,
		cluster_admins: [],
	},
	dns: { enabled: false },
	repositories: {},
	source_repos: [],
	databases: [],
	caches: [],
	queues: [],
	topics: [],
	nosql_tables: [],
	secrets: [],
} as ProjectFormData;

function FormWrapper({
	children,
	defaultValues,
}: {
	children: React.ReactNode;
	defaultValues?: Partial<ProjectFormData>;
}) {
	const form = useForm<ProjectFormInput, unknown, ProjectFormData>({
		resolver: zodResolver(projectFormSchema),
		defaultValues: { ...DEFAULT_VALUES, ...defaultValues },
		mode: "onChange",
	});

	return (
		<FormProvider {...form}>{children}</FormProvider>
	);
}

export function renderWithForm(
	ui: React.ReactElement,
	defaultValues?: Partial<ProjectFormData>,
) {
	return render(ui, {
		wrapper: ({ children }) => (
			<FormWrapper defaultValues={defaultValues}>{children}</FormWrapper>
		),
	});
}

export { DEFAULT_VALUES };
