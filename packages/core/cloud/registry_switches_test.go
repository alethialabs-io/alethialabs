// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloud

import (
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
)

// The canvas's two registry switches — "Immutable tags" and "Vulnerability scanning" — are carried
// into a tfvars VALUE that differs between the ON and the OFF position, on every cloud that can
// honor them. Every assertion below sets the switch BOTH ways and compares the emitted value.
//
// Asserting only that the key is present is what let this ship broken for so long:
// registry_parity_test.go asserted `provision_artifact_registry` was true and passed for years while
// `artifact_registry_repos` was emitted by nothing, so GCP created zero repositories (#1835). A key
// with a constant value proves the plumbing runs, not that the user's choice survives it.
//
// Azure is deliberately absent: ACR exposes neither setting through Resource Manager at all, so both
// cells are documented exclusions in infra/offer-exclusions.yaml rather than gaps.

func ptrBool(v bool) *bool { return &v }

// registryConfig is one native registry component with both switches in a stated position.
func registryConfig(immutable, scanning bool) *types.ProjectConfig {
	return &types.ProjectConfig{
		ProjectName: "acme",
		Region:      "us-east-1",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{
			Name:                  "apps",
			ImmutableTags:         ptrBool(immutable),
			VulnerabilityScanning: ptrBool(scanning),
		}},
	}
}

// ecrSettingsFor digs one repository's entry out of `ecr_repo_settings`, failing the test rather
// than panicking when the key or the shape is not what the template declares.
func ecrSettingsFor(t *testing.T, tfvars map[string]interface{}, name string) map[string]interface{} {
	t.Helper()
	all, ok := tfvars["ecr_repo_settings"].(map[string]interface{})
	if !ok {
		t.Fatalf("ecr_repo_settings is %T, want map[string]interface{}", tfvars["ecr_repo_settings"])
	}
	entry, ok := all[name].(map[string]interface{})
	if !ok {
		t.Fatalf("ecr_repo_settings[%q] is %T (keys: %v), want map[string]interface{}", name, all[name], keysOf(all))
	}
	return entry
}

func keysOf(m map[string]interface{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ECR takes both switches PER REPOSITORY — they are attributes of `aws_ecr_repository`, and ecr.tf
// already for_eaches — so the provider emits one entry per native registry component. Both
// directions are pinned: a template that hardcoded IMMUTABLE would pass an ON-only assertion.
func TestAWSRegistrySwitchesReachTheirTfvars(t *testing.T) {
	p := &awsProvider{}

	on := ecrSettingsFor(t, p.ProviderTfvars(registryConfig(true, true)), "apps")
	if on["immutable_tags"] != true {
		t.Errorf("immutable_tags ON → ecr_repo_settings[apps].immutable_tags = %v, want true", on["immutable_tags"])
	}
	if on["vulnerability_scanning"] != true {
		t.Errorf("vulnerability_scanning ON → ecr_repo_settings[apps].vulnerability_scanning = %v, want true", on["vulnerability_scanning"])
	}

	off := ecrSettingsFor(t, p.ProviderTfvars(registryConfig(false, false)), "apps")
	if off["immutable_tags"] != false {
		t.Errorf("immutable_tags OFF → ecr_repo_settings[apps].immutable_tags = %v, want false", off["immutable_tags"])
	}
	if off["vulnerability_scanning"] != false {
		t.Errorf("vulnerability_scanning OFF → ecr_repo_settings[apps].vulnerability_scanning = %v, want false", off["vulnerability_scanning"])
	}
}

// THE ASSERTION THIS LANE WAS MISSING, and the reason the settings are a map at all.
//
// An earlier cut OR-aggregated every component into two registry-wide scalars, on the stated
// grounds that "ECR expresses these registry-wide". ECR does not — `image_tag_mutability` is a
// repository property. The cost was silent and one-directional: the component asking to be LESS
// safe was overruled without being told, so a user who deliberately set MUTABLE (to overwrite a
// `latest` tag, say) got IMMUTABLE and a push that fails with no explanation.
//
// Two components, opposite answers, and they must STAY opposite.
func TestAWSRegistrySwitchesStayPerRepository(t *testing.T) {
	config := &types.ProjectConfig{
		ProjectName: "acme",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{
			{Name: "lax", ImmutableTags: ptrBool(false), VulnerabilityScanning: ptrBool(false)},
			{Name: "strict", ImmutableTags: ptrBool(true), VulnerabilityScanning: ptrBool(true)},
		},
	}
	tfvars := (&awsProvider{}).ProviderTfvars(config)

	lax := ecrSettingsFor(t, tfvars, "lax")
	if lax["immutable_tags"] != false || lax["vulnerability_scanning"] != false {
		t.Errorf("the lax registry was overruled by its neighbour: %v", lax)
	}
	strict := ecrSettingsFor(t, tfvars, "strict")
	if strict["immutable_tags"] != true || strict["vulnerability_scanning"] != true {
		t.Errorf("the strict registry was overruled by its neighbour: %v", strict)
	}
}

// THE UPGRADE-SAFETY ASSERTION, and the reason both fields are pointers.
//
// The AWS template has always defaulted to IMMUTABLE + scan-on-push, so every repository Alethia has
// ever built has both ON. A project with no native registry component, or a snapshot predating the
// typed columns, must therefore emit the template's own defaults — never false. Emitting false there
// would rewrite `image_tag_mutability` to MUTABLE and switch scanning off on every repository a live
// project already has, on the first apply after this change, with nobody having touched a switch.
func TestAWSRegistrySwitchesDoNotDowngradeAnUnaskedProject(t *testing.T) {
	cases := map[string]*types.ProjectConfig{
		"no registry component at all": {ProjectName: "acme"},
		"a registry with both switches unset (an older row)": {
			ProjectName:         "acme",
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "apps"}},
		},
		"only a pluggable registry — ECR is not ours to configure": {
			ProjectName: "acme",
			ContainerRegistries: []types.ProjectContainerRegistryConfig{{
				Name:                  "apps",
				Provider:              "ghcr",
				ImmutableTags:         ptrBool(false),
				VulnerabilityScanning: ptrBool(false),
			}},
		},
	}
	for name, config := range cases {
		got := (&awsProvider{}).ProviderTfvars(config)

		// The project-wide fallbacks stay at the template's own defaults. Every repository that
		// `ecr_repo_settings` does not name resolves against these, including every repository in
		// every snapshot written before the map existed.
		if got["ecr_repository_image_tag_mutability"] != "IMMUTABLE" {
			t.Errorf("%s: ecr_repository_image_tag_mutability = %v, want IMMUTABLE (the template default — anything else downgrades live repositories)", name, got["ecr_repository_image_tag_mutability"])
		}
		if got["ecr_repository_image_scan_on_push"] != true {
			t.Errorf("%s: ecr_repository_image_scan_on_push = %v, want true (the template default)", name, got["ecr_repository_image_scan_on_push"])
		}

		settings, ok := got["ecr_repo_settings"].(map[string]interface{})
		if !ok {
			t.Fatalf("%s: ecr_repo_settings is %T, want map[string]interface{}", name, got["ecr_repo_settings"])
		}
		switch name {
		case "a registry with both switches unset (an older row)":
			// An unset switch reads as the SAFE setting, not as false.
			entry := ecrSettingsFor(t, got, "apps")
			if entry["immutable_tags"] != true || entry["vulnerability_scanning"] != true {
				t.Errorf("%s: an unset switch must read as the safe setting, got %v", name, entry)
			}
		default:
			// No native registry component: nothing to answer for, so nothing is emitted, and
			// every repository the template builds takes the defaults above.
			if len(settings) != 0 {
				t.Errorf("%s: ecr_repo_settings = %v, want empty (no native registry component)", name, settings)
			}
		}
	}
}

// GCP carries the switch per repository, as an attribute of `artifact_registry_repos`, which the
// module reads as `docker_config.immutable_tags`.
func TestGCPArtifactRegistryReposCarryImmutableTags(t *testing.T) {
	p := &gcpProvider{}

	on := p.ProviderTfvars(registryConfig(true, true))
	repos, ok := on["artifact_registry_repos"].(map[string]interface{})
	if !ok || len(repos) != 1 {
		t.Fatalf("artifact_registry_repos = %v, want one entry keyed by the component name", on["artifact_registry_repos"])
	}
	if repos["apps"].(map[string]interface{})["immutable_tags"] != true {
		t.Errorf("immutable_tags ON → %v, want true", repos["apps"])
	}

	off := p.ProviderTfvars(registryConfig(false, false))
	offRepos := off["artifact_registry_repos"].(map[string]interface{})
	if offRepos["apps"].(map[string]interface{})["immutable_tags"] != false {
		t.Errorf("immutable_tags OFF → %v, want false", offRepos["apps"])
	}
}

// #1835: `provision_artifact_registry` was derived from the mere PRESENCE of a registry row while
// `artifact_registry_repos` was emitted by nothing at all, so the flag read true, the module's
// for_each resolved to {}, and GCP built ZERO repositories. Both must come from the same source.
func TestGCPArtifactRegistryFlagAgreesWithItsRepos(t *testing.T) {
	cases := map[string]*types.ProjectConfig{
		"no registries":                 {ProjectName: "acme"},
		"only a pluggable registry":     {ProjectName: "acme", ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "apps", Provider: "ghcr"}}},
		"a registry with an empty name": {ProjectName: "acme", ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: ""}}},
	}
	for name, config := range cases {
		got := (&gcpProvider{}).ProviderTfvars(config)
		repos := got["artifact_registry_repos"].(map[string]interface{})
		if len(repos) != 0 {
			t.Errorf("%s: artifact_registry_repos = %v, want empty", name, repos)
		}
		if got["provision_artifact_registry"] != false {
			t.Errorf("%s: provision_artifact_registry = %v with no repositories to create — this is exactly #1835", name, got["provision_artifact_registry"])
		}
	}

	got := (&gcpProvider{}).ProviderTfvars(registryConfig(true, true))
	if got["provision_artifact_registry"] != true {
		t.Errorf("one native registry component → provision_artifact_registry = %v, want true", got["provision_artifact_registry"])
	}
}

// Alibaba carries the switch per repository too, onto `alicloud_cr_ee_repo.tag_immutability` — a
// resource that did not exist until #1837, which is precisely why the switch could not be carried.
func TestAlibabaCRReposCarryImmutableTags(t *testing.T) {
	p := &alibabaProvider{}

	on := p.ProviderTfvars(registryConfig(true, true))
	repos, ok := on["cr_repos"].(map[string]interface{})
	if !ok || len(repos) != 1 {
		t.Fatalf("cr_repos = %v, want one entry keyed by the component name", on["cr_repos"])
	}
	if repos["apps"].(map[string]interface{})["immutable_tags"] != true {
		t.Errorf("immutable_tags ON → %v, want true", repos["apps"])
	}

	off := p.ProviderTfvars(registryConfig(false, false))
	offRepos := off["cr_repos"].(map[string]interface{})
	if offRepos["apps"].(map[string]interface{})["immutable_tags"] != false {
		t.Errorf("immutable_tags OFF → %v, want false", offRepos["apps"])
	}
}

// #1837 in the other direction: `provision_cr` buys a Container Registry ENTERPRISE EDITION
// instance, which is `payment_type = "Subscription"`. Turning it on with no repository to create
// bought a monthly subscription and a namespace nobody can push to — so the flag must follow the
// repositories, not the mere presence of a row.
func TestAlibabaCRFlagAgreesWithItsRepos(t *testing.T) {
	pluggable := &types.ProjectConfig{
		ProjectName:         "acme",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "apps", Provider: "harbor"}},
	}
	got := (&alibabaProvider{}).ProviderTfvars(pluggable)
	if len(got["cr_repos"].(map[string]interface{})) != 0 {
		t.Errorf("a pluggable registry must not produce a CR repository, got %v", got["cr_repos"])
	}
	if got["provision_cr"] != false {
		t.Error("provision_cr is true with no repository to create — that buys a paid CR EE subscription for nothing")
	}
}

// An older row, or a hand-written snapshot, arrives with the switch unset. On the per-repository
// clouds that must read as the SAFE setting — which is also what the module's `optional(bool, true)`
// would have produced — so an upgrade never turns a live repository's tags mutable by itself.
func TestUnsetImmutableTagsReadsAsTheSaferSetting(t *testing.T) {
	config := &types.ProjectConfig{
		ProjectName:         "acme",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "apps"}},
	}

	gcpRepos := (&gcpProvider{}).ProviderTfvars(config)["artifact_registry_repos"].(map[string]interface{})
	if gcpRepos["apps"].(map[string]interface{})["immutable_tags"] != true {
		t.Errorf("gcp: an unset switch must read as true, got %v", gcpRepos["apps"])
	}

	crRepos := (&alibabaProvider{}).ProviderTfvars(config)["cr_repos"].(map[string]interface{})
	if crRepos["apps"].(map[string]interface{})["immutable_tags"] != true {
		t.Errorf("alibaba: an unset switch must read as true, got %v", crRepos["apps"])
	}
}

// GCP carries `vulnerability_scanning` per repository too, which the module maps onto
// `vulnerability_scanning_config.enablement_config` (#1844). The mapping is the interesting half:
// the enum is INHERITED | DISABLED with no ENABLED, so ON can only mean "follow the project
// default" — asserted on the template side by checks_registry.tftest.hcl. Here we pin only that the
// bool reaches tfvars per repository and that the two positions differ.
func TestGCPArtifactRegistryReposCarryVulnerabilityScanning(t *testing.T) {
	p := &gcpProvider{}

	on := p.ProviderTfvars(registryConfig(true, true))
	repos := on["artifact_registry_repos"].(map[string]interface{})
	if repos["apps"].(map[string]interface{})["vulnerability_scanning"] != true {
		t.Errorf("vulnerability_scanning ON → %v, want true", repos["apps"])
	}

	off := p.ProviderTfvars(registryConfig(true, false))
	offRepos := off["artifact_registry_repos"].(map[string]interface{})
	if offRepos["apps"].(map[string]interface{})["vulnerability_scanning"] != false {
		t.Errorf("vulnerability_scanning OFF → %v, want false", offRepos["apps"])
	}
}

// The two GCP registry switches read OPPOSITE defaults when unset, and that asymmetry is deliberate
// rather than an oversight — so pin it, or a later "consistency" pass will quietly align them.
//
// `immutable_tags` unset reads TRUE: the safe setting, and what the module's `optional(bool, true)`
// would have produced anyway, so an upgrade never turns a live repository's tags mutable.
//
// `vulnerability_scanning` unset reads FALSE, because ON is not free on GCP. It requires
// `containerscanning.googleapis.com` enabled on the tenant's project — an onboarding prerequisite
// the customer performs — and the template REFUSES the ON position when it is absent. A silent
// field defaulting to ON would therefore fail the plan of every project whose tenant has not done
// that step, on a switch nobody set.
func TestUnsetGCPScanningReadsAsOffWhileImmutableTagsReadsAsOn(t *testing.T) {
	config := &types.ProjectConfig{
		ProjectName:         "acme",
		ContainerRegistries: []types.ProjectContainerRegistryConfig{{Name: "apps"}},
	}

	repo := (&gcpProvider{}).ProviderTfvars(config)["artifact_registry_repos"].(map[string]interface{})["apps"].(map[string]interface{})
	if repo["immutable_tags"] != true {
		t.Errorf("unset immutable_tags = %v, want true (the safe setting)", repo["immutable_tags"])
	}
	if repo["vulnerability_scanning"] != false {
		t.Errorf("unset vulnerability_scanning = %v, want false — ON needs a project API the tenant may not have enabled, and the template refuses it", repo["vulnerability_scanning"])
	}
}
