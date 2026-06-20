"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only


import { createSpec, type CreateSpecInput } from "@/app/server/actions/specs";
import type { CloudIdentityOption } from "@/app/server/actions/aws/identities";
import { specFormSchema, type SpecFormData, type SpecFormInput } from "@/lib/validations/spec-form.schema";
import {
	useCloudProvider,
	DEFAULT_INSTANCE_TYPE,
	DEFAULT_K8S_VERSION,
	AUTOSCALER,
	type CloudProviderSlug,
} from "@/lib/cloud-providers";
import { convertSpecConfig, type ConversionWarning } from "@/lib/cloud-providers/convert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useSpecStore } from "@/lib/stores/use-spec-store";
import { RepositoryProvider } from "./repository-context";
import { ProviderRibbon } from "./provider-ribbon";
import { CostSidebar } from "./cost-sidebar";
import { SectionProjectBasics } from "./section-project-basics";
import { SectionNetwork } from "./section-network";
import { SectionCluster } from "./section-cluster";
import { SectionDatabases } from "./section-databases";
import { SectionCaches } from "./section-caches";
import { SectionNosql } from "./section-nosql";
import { SectionMessaging } from "./section-messaging";
import { SectionDns } from "./section-dns";
import { SectionSecrets } from "./section-secrets";
import { SectionRepositories } from "./section-repositories";
import { ReviewTab } from "./review-tab";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, ChevronsUpDown, Info, Loader2, Rocket } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export interface SourceSpecData {
	formData: SpecFormData;
	provider: CloudProviderSlug;
}

interface DesignSpecFormProps {
	cloudIdentities: CloudIdentityOption[];
	sourceSpec?: SourceSpecData;
}

/** Outer wrapper that provides the CloudProvider context. */
export function DesignSpecForm({ cloudIdentities, sourceSpec }: DesignSpecFormProps) {
	return (
		<RepositoryProvider>
			<DesignSpecFormInner cloudIdentities={cloudIdentities} sourceSpec={sourceSpec} />
		</RepositoryProvider>
	);
}

const fieldToSectionId: Record<string, string> = {
	spec: "section-project-basics",
	network: "section-network",
	cluster: "section-cluster",
	databases: "section-databases",
	caches: "section-caches",
	nosql_tables: "section-nosql",
	queues: "section-messaging",
	topics: "section-messaging",
	dns: "section-dns",
	secrets: "section-secrets",
	repositories: "section-repositories",
};

/** Inner form component with access to CloudProvider context. */
function DesignSpecFormInner({ cloudIdentities, sourceSpec }: DesignSpecFormProps) {
	const router = useRouter();
	const storeError = useSpecStore((s) => s.error);
	const isLoading = useSpecStore((s) => s.isLoading);
	const reset = useSpecStore((s) => s.reset);
	const fetchPrices = useSpecStore((s) => s.fetchPrices);
	const setSubmitting = useSpecStore((s) => s.setSubmitting);
	const setError = useSpecStore((s) => s.setError);
	const [conversionWarnings, setConversionWarnings] = useState<ConversionWarning[]>([]);

	const defaultFormValues: SpecFormData = sourceSpec?.formData ?? {
		spec: {
			project_name: "",
			environment_stage: "development",
			region: "",
			cloud_identity_id: "",
			iac_version: "1.11.4",
			zone_id: "",
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
	};

	const form = useForm<SpecFormInput, unknown, SpecFormData>({
		resolver: zodResolver(specFormSchema),
		defaultValues: defaultFormValues,
		mode: "onChange",
	});

	useEffect(() => {
		reset();
		return () => { reset(); };
	}, [reset]);

	const region = form.watch("spec.region");
	useEffect(() => {
		if (region) fetchPrices(region);
	}, [region]);

	const { provider } = useCloudProvider();
	const prevProviderRef = useRef(provider);
	useEffect(() => {
		if (provider !== prevProviderRef.current) {
			prevProviderRef.current = provider;
			const autoscalerKey = AUTOSCALER[provider].providerConfigKey;

			form.setValue("spec.region", "");
			form.setValue("cluster.cluster_version", DEFAULT_K8S_VERSION[provider]);
			form.setValue("cluster.instance_types", [DEFAULT_INSTANCE_TYPE[provider]]);
			form.setValue("cluster.provider_config", { [autoscalerKey]: true });
			form.setValue("network.provision_network", true);
			form.setValue("network.network_id", "");
			form.setValue("network.cidr_block", "10.0.0.0/16");
			form.setValue("dns.zone_id", "");
			form.setValue("dns.domain_name", "");
			form.setValue("dns.provider_config", {});
			form.setValue("databases", []);
			form.setValue("caches", []);
		}
	}, [provider]);

	useEffect(() => {
		if (!sourceSpec || provider === sourceSpec.provider) return;
		const { data: converted, warnings } = convertSpecConfig(
			sourceSpec.formData,
			sourceSpec.provider,
			provider,
		);
		setConversionWarnings(warnings);
		form.reset(converted);
	}, [provider, sourceSpec]);

	const onSubmit = async (data: SpecFormData) => {
		setSubmitting();
		try {
			const input = data as unknown as CreateSpecInput;
			const { spec } = await createSpec(input);
			reset();
			toast.success("Spec created successfully!");
			if (spec.zone_id) {
				router.push(`/dashboard/zones/${spec.zone_id}/specs/${spec.id}`);
			} else {
				router.push("/dashboard/specs");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "An unexpected error occurred");
		}
	};

	const onError = (errors: Record<string, unknown>) => {
		const firstErrorKey = Object.keys(errors)[0];
		const sectionId = fieldToSectionId[firstErrorKey];
		if (sectionId) {
			document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
		}

		const keys = Object.keys(errors);
		toast.error(`Please fix the highlighted fields before creating. (${keys.join(", ")})`);
	};

	return (
		<FormProvider {...form}>
			<form onSubmit={form.handleSubmit(onSubmit, onError)} className="space-y-6">
				<ProviderRibbon identities={cloudIdentities} />

				{sourceSpec && (
					<Alert variant="default" className="border-border bg-muted">
						<Info className="h-4 w-4 text-muted-foreground" />
						<AlertDescription className="text-sm">
							Duplicating from <span className="font-medium">{sourceSpec.formData.spec.project_name}</span>.
							Select a cloud account to convert the configuration.
						</AlertDescription>
					</Alert>
				)}

				{conversionWarnings.length > 0 && (
					<Alert variant="default" className="border-border bg-muted">
						<AlertTriangle className="h-4 w-4 text-muted-foreground" />
						<AlertDescription>
							<p className="text-sm font-medium mb-1">Conversion notes:</p>
							<ul className="text-xs space-y-1">
								{conversionWarnings.map((w, i) => (
									<li key={i} className="flex items-start gap-1.5">
										<span className="text-muted-foreground">[{w.component}]</span>
										<span>{w.message}</span>
									</li>
								))}
							</ul>
						</AlertDescription>
					</Alert>
				)}

				<div className="flex gap-6">
					<div className="flex-1 min-w-0 space-y-6">
						<div id="section-project-basics" className="scroll-mt-20">
							<SectionProjectBasics />
						</div>
						<div id="section-network" className="scroll-mt-20">
							<SectionNetwork />
						</div>
						<div id="section-cluster" className="scroll-mt-20">
							<SectionCluster />
						</div>
						<div id="section-databases" className="scroll-mt-20">
							<SectionDatabases />
						</div>
						<div id="section-caches" className="scroll-mt-20">
							<SectionCaches />
						</div>
						<div id="section-nosql" className="scroll-mt-20">
							<SectionNosql />
						</div>
						<div id="section-messaging" className="scroll-mt-20">
							<SectionMessaging />
						</div>
						<div id="section-dns" className="scroll-mt-20">
							<SectionDns />
						</div>
						<div id="section-secrets" className="scroll-mt-20">
							<SectionSecrets />
						</div>
						<div id="section-repositories" className="scroll-mt-20">
							<SectionRepositories />
						</div>

						<Collapsible>
							<CollapsibleTrigger asChild>
								<button
									type="button"
									className="flex w-full items-center justify-between rounded-lg border border-border/40 bg-muted/5 px-4 py-3 text-sm font-medium hover:bg-muted/20 transition-colors"
								>
									<span className="flex items-center gap-2">
										<CheckCircle2 className="h-4 w-4 text-muted-foreground" />
										Review Configuration
									</span>
									<ChevronsUpDown className="h-4 w-4 text-muted-foreground" />
								</button>
							</CollapsibleTrigger>
							<CollapsibleContent className="pt-4">
								<ReviewTab />
							</CollapsibleContent>
						</Collapsible>

						<div className="flex items-center justify-end gap-4 pb-8">
							{storeError && <p className="text-sm text-destructive">{storeError}</p>}
							<Button type="submit" disabled={isLoading} className="min-w-[160px]">
								{isLoading ? (
									<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</>
								) : (
									<><Rocket className="mr-2 h-4 w-4" />Create Spec</>
								)}
							</Button>
						</div>
					</div>

					<div className="hidden lg:block w-72 shrink-0">
						<CostSidebar />
					</div>
				</div>
			</form>
		</FormProvider>
	);
}
