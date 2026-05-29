import { describe, expect, it } from "vitest";
import {
	formatInstallerConfig,
	stripConfigurationMetadata,
	configurationToInstallerYaml,
} from "@/lib/configurations/installer-config";

describe("formatInstallerConfig", () => {
	const base = {
		project_name: "my-vine",
		environment_stage: "production",
		aws_region: "eu-west-1",
		aws_account_id: "123456789012",
		terraform_version: "1.11.4",
		container_platform: "standard",
		create_vpc: true,
		vpc_cidr: "10.0.0.0/16",
		enable_dns: false,
		create_rds: true,
		db_min_capacity: 2,
		enable_redis: false,
		enable_karpenter: true,
		enable_cloudfront_waf: false,
	};

	it("maps core fields correctly", () => {
		const result = formatInstallerConfig(base);
		expect(result.project_name).toBe("my-vine");
		expect(result.environment).toBe("production");
		expect(result.region).toBe("eu-west-1");
		expect(result.aws_account_id).toBe("123456789012");
		expect(result.terraform_ver).toBe("1.11.4");
	});

	it("sets standard template repos", () => {
		const result = formatInstallerConfig(base);
		expect(result.env_template_repo).toContain("adp-tf-envtempl-standard");
		expect(result.env_template_repo_branch).toBe("v1.2.7");
		expect(result.gitops_template_repo).toContain(
			"adp-k8s-templ-argoinfrasvcs",
		);
	});

	it("sets AI template repos when ai-workloads", () => {
		const result = formatInstallerConfig({
			...base,
			container_platform: "ai-workloads",
		});
		expect(result.env_template_repo_branch).toBe("v1.2.3-ai");
		expect(result.gitops_template_repo).toContain("adp-k8s-aitempl");
	});

	it("uses main branch for custom platform", () => {
		const result = formatInstallerConfig({
			...base,
			container_platform: "custom",
		});
		expect(result.env_template_repo_branch).toBe("main");
	});

	it("maps VPC config", () => {
		const result = formatInstallerConfig(base);
		expect(result.provision_vpc).toBe(true);
		expect(result.vpc_cidr).toBe("10.0.0.0/16");
		expect(result.vpc_single_nat_gateway).toBe(true);
	});

	it("maps RDS with scaling config", () => {
		const result = formatInstallerConfig(base);
		expect(result.create_rds).toBe(true);
		expect(result.rds_scaling_config).toEqual({ min_capacity: 2 });
	});

	it("sets hardcoded defaults", () => {
		const result = formatInstallerConfig(base);
		expect(result.enable_fluent_bit).toBe(true);
		expect(result.enable_karpenter).toBe(true);
		expect(result.provision_ecr).toBe(false);
		expect(result.eks_ng_min_size).toBe(3);
		expect(result.eks_ng_max_size).toBe(4);
	});

	it("includes ArgoCD token when provided", () => {
		const result = formatInstallerConfig({
			...base,
			gitops_argocd_token: "ghp_test123",
		});
		expect(result.gitops_argo_access_token).toBe("ghp_test123");
	});

	it("omits ArgoCD token when not provided", () => {
		const result = formatInstallerConfig(base);
		expect(result.gitops_argo_access_token).toBeUndefined();
	});
});

describe("stripConfigurationMetadata", () => {
	it("removes system fields", () => {
		const config = {
			id: "uuid",
			user_id: "uuid",
			created_at: "2026-01-01",
			updated_at: "2026-01-01",
			status: "draft",
			cluster_id: "uuid",
			cloud_identity_id: "uuid",
			download_count: 5,
			last_downloaded_at: "2026-01-01",
			full_config: {},
			project_name: "test",
		};
		const result = stripConfigurationMetadata(config);
		expect(result.project_name).toBe("test");
		expect(result.id).toBeUndefined();
		expect(result.user_id).toBeUndefined();
		expect(result.status).toBeUndefined();
	});
});

describe("configurationToInstallerYaml", () => {
	it("produces valid YAML string", () => {
		const config = {
			id: "1",
			user_id: "1",
			created_at: "",
			updated_at: "",
			status: "draft",
			project_name: "yaml-test",
			environment_stage: "dev",
			aws_region: "us-east-1",
			terraform_version: "1.11.4",
			container_platform: "standard",
		};
		const yaml = configurationToInstallerYaml(config);
		expect(yaml).toContain("project_name");
		expect(yaml).toContain("yaml-test");
		expect(typeof yaml).toBe("string");
	});
});
