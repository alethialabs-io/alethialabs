import React from "react";
import { render } from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { vineFormSchema, type VineFormData } from "@/lib/validations/vine-form.schema";
import { CloudProviderProvider } from "@/lib/cloud-providers";

const DEFAULT_VALUES: VineFormData = {
	vine: {
		project_name: "",
		environment_stage: "development",
		region: "",
		cloud_identity_id: "",
		vineyard_id: "",
		terraform_version: "1.11.4",
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
	databases: [],
	caches: [],
	queues: [],
	topics: [],
	nosql_tables: [],
	secrets: [],
} as VineFormData;

function FormWrapper({
	children,
	defaultValues,
}: {
	children: React.ReactNode;
	defaultValues?: Partial<VineFormData>;
}) {
	const form = useForm<VineFormData>({
		resolver: zodResolver(vineFormSchema) as any,
		defaultValues: { ...DEFAULT_VALUES, ...defaultValues } as any,
		mode: "onChange",
	});

	return (
		<CloudProviderProvider>
			<FormProvider {...form}>{children}</FormProvider>
		</CloudProviderProvider>
	);
}

export function renderWithForm(
	ui: React.ReactElement,
	defaultValues?: Partial<VineFormData>,
) {
	return render(ui, {
		wrapper: ({ children }) => (
			<FormWrapper defaultValues={defaultValues}>{children}</FormWrapper>
		),
	});
}

export { DEFAULT_VALUES };
