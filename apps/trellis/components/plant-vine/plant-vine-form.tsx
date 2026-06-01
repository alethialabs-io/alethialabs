"use client";

import { createVine, type CreateVineInput } from "@/app/server/actions/vines";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { vineFormSchema, type VineFormData } from "@/lib/validations/vine-form.schema";
import {
	CloudProviderProvider,
	useCloudProvider,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	AUTOSCALER,
} from "@/lib/cloud-providers";
import { useVineStore } from "./use-vine-store";
import { RepositoryProvider } from "./repository-context";
import { ProviderRibbon } from "./provider-ribbon";
import { VineFormTabs, type VineFormTabsHandle } from "./vine-form-tabs";
import { CostSidebar } from "./cost-sidebar";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

interface PlantVineFormProps {
	cloudIdentities: CloudIdentityOption[];
}

/** Outer wrapper that provides the CloudProvider context. */
export function PlantVineForm({ cloudIdentities }: PlantVineFormProps) {
	return (
		<CloudProviderProvider>
			<RepositoryProvider>
				<PlantVineFormInner cloudIdentities={cloudIdentities} />
			</RepositoryProvider>
		</CloudProviderProvider>
	);
}

/** Inner form component with access to CloudProvider context. */
function PlantVineFormInner({ cloudIdentities }: PlantVineFormProps) {
	const router = useRouter();
	const store = useVineStore();

	const form = useForm<VineFormData>({
		resolver: zodResolver(vineFormSchema) as any,
		defaultValues: {
			vine: {
				project_name: "",
				environment_stage: "development",
				region: "",
				cloud_identity_id: "",
				terraform_version: "1.11.4",
				vineyard_id: "",
			},
			network: {
				provision_network: true,
				cidr_block: "10.0.0.0/16",
				single_nat_gateway: true,
			},
			cluster: {
				cluster_version: DEFAULT_K8S_VERSION.aws,
				provider_config: { enable_karpenter: true },
				instance_types: [DEFAULT_INSTANCE_TYPE.aws],
				node_min_size: 2,
				node_max_size: 5,
				node_desired_size: 2,
			},
			dns: {
				enabled: false,
				managed_certificate: false,
				waf_enabled: false,
				provider_config: {},
			},
			repositories: {},
			databases: [],
			caches: [],
			queues: [],
			topics: [],
			nosql_tables: [],
			secrets: [],
		},
		mode: "onChange",
	});

	const region = form.watch("vine.region");
	useEffect(() => {
		if (region) store.fetchPrices(region);
	}, [region]);

	const { provider } = useCloudProvider();
	const prevProviderRef = useRef(provider);
	useEffect(() => {
		if (provider !== prevProviderRef.current) {
			prevProviderRef.current = provider;
			const autoscalerKey = AUTOSCALER[provider].providerConfigKey;

			// Region — invalid across providers
			form.setValue("vine.region", "");

			// Cluster — versions, types, autoscaler differ
			form.setValue("cluster.cluster_version", DEFAULT_K8S_VERSION[provider]);
			form.setValue("cluster.instance_types", [DEFAULT_INSTANCE_TYPE[provider]]);
			form.setValue("cluster.provider_config", { [autoscalerKey]: true });

			// Network — reset to create mode, clear stale IDs
			form.setValue("network.provision_network", true);
			form.setValue("network.network_id", "");
			form.setValue("network.cidr_block", "10.0.0.0/16");

			// DNS — zone IDs differ across providers
			form.setValue("dns.zone_id", "");
			form.setValue("dns.domain_name", "");
			form.setValue("dns.provider_config", {});

			// Services with provider-specific values (engines, node types)
			form.setValue("databases", []);
			form.setValue("caches", []);
		}
	}, [provider, form]);

	const onSubmit = async (data: VineFormData) => {
		store.set({ isLoading: true, error: null });
		try {
			const input = data as unknown as CreateVineInput;
			const { vine } = await createVine(input);
			toast.success("Vine planted successfully!");
			if (vine.vineyard_id) {
				router.push(`/dashboard/vineyards/${vine.vineyard_id}`);
			} else {
				router.push("/dashboard/vines");
			}
		} catch (err) {
			store.set({
				error: err instanceof Error ? err.message : "An unexpected error occurred",
				isLoading: false,
			});
		}
	};

	const tabsRef = useRef<VineFormTabsHandle>(null);

	/** Maps form field paths to the tab that contains them. */
	const fieldToTab: Record<string, string> = {
		vine: "core", network: "core", cluster: "core",
		databases: "services", caches: "services", nosql_tables: "services", queues: "services", topics: "services",
		dns: "security", secrets: "security",
		repositories: "git",
	};

	const onError = (errors: Record<string, unknown>) => {
		store.set({ submitted: true });

		const firstErrorKey = Object.keys(errors)[0];
		const tab = fieldToTab[firstErrorKey] ?? "core";
		tabsRef.current?.setActiveTab(tab);

		const keys = Object.keys(errors);
		const summary = Object.entries(errors).map(([k, v]) => {
			const nested = v && typeof v === "object" ? Object.keys(v as object) : [];
			const msg = (v as any)?.message || (nested.length ? nested.join(", ") : "unknown");
			return `${k}: ${msg}`;
		});
		console.error("[PlantVine] Validation errors:", summary);
		toast.error(`Please fix the highlighted fields before planting. (${keys.join(", ")})`);
	};

	return (
		<FormProvider {...form}>
			<form onSubmit={form.handleSubmit(onSubmit, onError)} className="space-y-6">
				{/* Provider Ribbon — always visible */}
				<ProviderRibbon identities={cloudIdentities} />

				{/* Main content: tabs + cost sidebar */}
				<div className="flex gap-6">
					<div className="flex-1 min-w-0">
						<VineFormTabs ref={tabsRef} />
					</div>

					<div className="hidden lg:block w-72 shrink-0">
						<CostSidebar />
					</div>
				</div>
			</form>
		</FormProvider>
	);
}
