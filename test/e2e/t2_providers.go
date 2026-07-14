// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// T2 provider table — the de-hetznerized configuration seam for the real-cloud
// provisioning proof (BYOC A0.1). t2_provision_test.go is build-tagged `e2e_t2`; this
// file is deliberately UNTAGGED (like controlplane.go / argocd_assert.go) so:
//
//   - `go mod tidy` sees its dependencies and the untagged unit test compiles it, and
//   - the credential-detection / region-default / timeout-default / REQUIRE-decision /
//     CLUSTER_JSON-merge logic can be exercised by t2_providers_test.go WITHOUT a
//     cloud, a token, or the e2e_t2 tag.
//
// Each provider row declares which credential env vars must be present, a sane cheap
// default region, and per-provider default timeouts (managed control planes boot far
// slower than a Talos VM, so aws/gcp/azure/alibaba get longer cluster-ready + overall
// waits than hetzner). Env overrides always win over the row defaults so a slow account
// or a non-default region can be tuned from the workflow without a code change.
//
// Nothing here imports `testing`; the tagged test and the unit test drive it.
package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// t2Provider is one row of the T2 provider table: everything the real-cloud proof needs
// to target a given cloud that is NOT the deploy spine itself (which reads the provider
// straight off the config snapshot).
type t2Provider struct {
	// name is the canonical provider key (matches infra/templates/project/<name> and the
	// snapshot `provider`).
	name string
	// defaultRegion is a cheap, generally-available region/zone used when neither
	// ALETHIA_E2E_REGION nor (for hetzner) the legacy ALETHIA_E2E_HCLOUD_REGION is set.
	defaultRegion string
	// clusterReadyTimeout is the runner's reachability-gate bound, passed verbatim as the
	// ALETHIA_CLUSTER_READY_TIMEOUT env string. A real managed control plane is much
	// slower to expose a reachable API than a Talos VM, hence the per-provider default.
	// Stored as a string (not time.Duration) so the hetzner default is bit-identical
	// ("8m", never "8m0s") to the value the current hard-coded path passes.
	clusterReadyTimeout string
	// waitTimeout bounds the test-side WaitTerminal poll for the job to go terminal
	// (image build + apply + spine + argo on real infra).
	waitTimeout time.Duration
	// credsPresent reports whether this provider's credentials are wired into the
	// environment, and (when not) a human message naming exactly what to set. It is a
	// closure so each cloud's distinct credential shape (ambient AWS keys vs a GCP
	// key-file path vs the three ARM_* vars vs alibaba's key-or-OIDC pair) is expressed
	// directly. It reads os.Getenv, so unit tests drive it with t.Setenv.
	credsPresent func() (ok bool, missingMsg string)
}

// t2ProviderTable is the source of truth for which clouds the T2 proof can target and
// how each is configured. Adding a cloud to the nightly is: add a row here + wire its
// secret + region into e2e-nightly.yml (per-cloud waves A1–A3). hetzner is the only row
// the nightly runs today.
var t2ProviderTable = map[string]t2Provider{
	// Talos on cheap Hetzner Cloud ARM VMs — the fastest-booting target, so the tightest
	// timeouts. HCLOUD_TOKEN is the single API token the hcloud/imager/talos providers
	// authenticate from.
	"hetzner": {
		name:                "hetzner",
		defaultRegion:       "nbg1",
		clusterReadyTimeout: "8m",
		waitTimeout:         25 * time.Minute,
		credsPresent: func() (bool, string) {
			return t2AllEnvPresent([]string{"HCLOUD_TOKEN"}),
				"HCLOUD_TOKEN is unset (the hetzner API token from repo secrets)"
		},
	},
	// AWS EKS. The workflow runs aws-actions/configure-aws-credentials (OIDC or static
	// keys) and sets ALETHIA_E2E_AWS_READY=1 to signal "creds are configured"; we
	// additionally sanity-check that at least one concrete credential handle
	// (AWS_ACCESS_KEY_ID or AWS_ROLE_ARN) is actually in the environment, so a missing
	// configure-step doesn't slip through as a green skip.
	"aws": {
		name: "aws",
		// us-east-1: the `alethia-e2e-nightly` role is region-LOCKED here (infra/aws-oidc
		// `e2e_region`), and eu-central-1/eu-west-1 are prod regions the role explicitly
		// forbids — so a default of anything but us-east-1 makes every AWS call AccessDenied.
		// The workflow also exports ALETHIA_E2E_REGION=us-east-1 for the nightly; this is the
		// local-run fallback.
		defaultRegion:       "us-east-1",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		credsPresent: func() (bool, string) {
			ready := t2Truthy(os.Getenv("ALETHIA_E2E_AWS_READY"))
			hasHandle := os.Getenv("AWS_ACCESS_KEY_ID") != "" || os.Getenv("AWS_ROLE_ARN") != ""
			return ready && hasHandle,
				"AWS credentials are not configured — set ALETHIA_E2E_AWS_READY=1 (after aws-actions/configure-aws-credentials) and ensure AWS_ACCESS_KEY_ID or AWS_ROLE_ARN is present"
		},
	},
	// GCP GKE. The gcloud/terraform providers read a service-account key file whose path
	// is GOOGLE_APPLICATION_CREDENTIALS. Region is a ZONAL location (europe-west3-a) so a
	// zonal GKE cluster + Cloud SQL are the cheapest shape.
	"gcp": {
		name:                "gcp",
		defaultRegion:       "europe-west3-a",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		credsPresent: func() (bool, string) {
			return t2AllEnvPresent([]string{"GOOGLE_APPLICATION_CREDENTIALS"}),
				"GOOGLE_APPLICATION_CREDENTIALS is unset (path to the GCP service-account key file)"
		},
	},
	// Azure AKS. The azurerm provider authenticates from the ARM_* service-principal /
	// federated-identity triple.
	"azure": {
		name:                "azure",
		defaultRegion:       "germanywestcentral",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		credsPresent: func() (bool, string) {
			return t2AllEnvPresent([]string{"ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID"}),
				"Azure credentials are incomplete — set ARM_CLIENT_ID, ARM_TENANT_ID and ARM_SUBSCRIPTION_ID"
		},
	},
	// Alibaba Cloud ACK. Either a static AccessKey (ALICLOUD_ACCESS_KEY) OR the keyless
	// OIDC/RAM-role pair (ALICLOUD_OIDC_TOKEN_FILE + ALICLOUD_ROLE_ARN) satisfies it.
	"alibaba": {
		name:                "alibaba",
		defaultRegion:       "eu-central-1",
		clusterReadyTimeout: "15m",
		waitTimeout:         50 * time.Minute,
		credsPresent: func() (bool, string) {
			static := os.Getenv("ALICLOUD_ACCESS_KEY") != ""
			oidc := os.Getenv("ALICLOUD_OIDC_TOKEN_FILE") != "" && os.Getenv("ALICLOUD_ROLE_ARN") != ""
			return static || oidc,
				"Alibaba credentials are unset — set ALICLOUD_ACCESS_KEY, or the keyless pair ALICLOUD_OIDC_TOKEN_FILE + ALICLOUD_ROLE_ARN"
		},
	},
}

// t2LookupProvider returns the provider row for name, or ok=false for an unknown
// provider (the caller HARD-FAILS — this replaces the old `provider != "hetzner"`
// fatal).
func t2LookupProvider(name string) (t2Provider, bool) {
	p, ok := t2ProviderTable[name]
	return p, ok
}

// t2SupportedProviders lists the table's provider keys (sorted) for error messages.
func t2SupportedProviders() string {
	keys := make([]string, 0, len(t2ProviderTable))
	for k := range t2ProviderTable {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ", ")
}

// t2AllEnvPresent reports whether every named env var is non-empty (after trimming).
func t2AllEnvPresent(keys []string) bool {
	for _, k := range keys {
		if strings.TrimSpace(os.Getenv(k)) == "" {
			return false
		}
	}
	return true
}

// resolveT2Region resolves the target region/zone for a provider: the generalized
// ALETHIA_E2E_REGION wins, then (hetzner only, for back-compat) the legacy
// ALETHIA_E2E_HCLOUD_REGION, then the row default. The legacy name is intentionally NOT
// honored for the other clouds — only hetzner ever used it.
func resolveT2Region(p t2Provider) string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_REGION")); v != "" {
		return v
	}
	if p.name == "hetzner" {
		if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_HCLOUD_REGION")); v != "" {
			return v
		}
	}
	return p.defaultRegion
}

// resolveT2ClusterReadyTimeout is the runner's reachability-gate timeout string: the
// ALETHIA_CLUSTER_READY_TIMEOUT override when set, else the provider row default.
func resolveT2ClusterReadyTimeout(p t2Provider) string {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_CLUSTER_READY_TIMEOUT")); v != "" {
		return v
	}
	return p.clusterReadyTimeout
}

// resolveT2WaitTimeout bounds how long the test waits for the job to finish: the
// ALETHIA_E2E_T2_WAIT override (a Go duration) when parseable, else the provider row
// default.
func resolveT2WaitTimeout(p t2Provider) time.Duration {
	if v := strings.TrimSpace(os.Getenv("ALETHIA_E2E_T2_WAIT")); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return p.waitTimeout
}

// t2RequireIsHard reports whether a missing prerequisite must HARD-FAIL rather than
// skip. The nightly sets ALETHIA_E2E_T2_REQUIRE=1 so a broken CI environment can never
// masquerade as a green skip; a dev laptop leaves it unset and skips cleanly.
func t2RequireIsHard() bool {
	return t2Truthy(os.Getenv("ALETHIA_E2E_T2_REQUIRE"))
}

// t2MergeClusterJSON merges ALETHIA_E2E_CLUSTER_JSON — a JSON object — into the seeded
// config snapshot's `cluster` block (ProjectClusterConfig: instance_types,
// node_desired_size, node_disk_size_gb, provider_config.enable_karpenter, …) so each
// cloud's workflow can pin its cheapest node shape WITHOUT editing template defaults.
// Absent/blank env ⇒ no-op (the template defaults stand). Malformed JSON, or JSON that
// is not an object, ⇒ a LOUD error (never silently ignored) so a typo in the workflow
// fails the run instead of quietly provisioning the wrong shape.
func t2MergeClusterJSON(snapshot map[string]any) error {
	raw := strings.TrimSpace(os.Getenv("ALETHIA_E2E_CLUSTER_JSON"))
	if raw == "" {
		return nil
	}
	var overrides map[string]any
	if err := json.Unmarshal([]byte(raw), &overrides); err != nil {
		return fmt.Errorf("ALETHIA_E2E_CLUSTER_JSON must be a JSON object: %w", err)
	}
	cluster, _ := snapshot["cluster"].(map[string]any)
	if cluster == nil {
		cluster = map[string]any{}
	}
	for k, v := range overrides {
		cluster[k] = v
	}
	snapshot["cluster"] = cluster
	return nil
}

// t2MergeNetworkJSON merges ALETHIA_E2E_NETWORK_JSON — a JSON object — into the seeded
// config snapshot's `network` block (ProjectNetworkConfig: single_nat_gateway, …), the
// sibling of t2MergeClusterJSON for network-tier knobs the `cluster` block can't carry.
// AWS uses it to fold `single_nat_gateway:true` into the FULL snapshot only (one NAT vs
// one-per-AZ ≈ halves the run's NAT cost) without editing the template default or the
// A0.5 fidelity base. Absent/blank env ⇒ no-op. Malformed / non-object JSON ⇒ a LOUD error
// (a workflow typo fails the run rather than silently provisioning the wrong network shape).
func t2MergeNetworkJSON(snapshot map[string]any) error {
	raw := strings.TrimSpace(os.Getenv("ALETHIA_E2E_NETWORK_JSON"))
	if raw == "" {
		return nil
	}
	var overrides map[string]any
	if err := json.Unmarshal([]byte(raw), &overrides); err != nil {
		return fmt.Errorf("ALETHIA_E2E_NETWORK_JSON must be a JSON object: %w", err)
	}
	network, _ := snapshot["network"].(map[string]any)
	if network == nil {
		network = map[string]any{}
	}
	for k, v := range overrides {
		network[k] = v
	}
	snapshot["network"] = network
	return nil
}

// t2ClusterKindPrefix maps a managed cloud to the resource-kind prefix its template's
// `locals.tf` stamps on the cluster name (`eks-…`/`gke-…`/`aks-…`). Talos/ACK are absent
// because they name the cluster bare `<project>-<env>` (no kind prefix) — see
// t2ValidateClusterName.
var t2ClusterKindPrefix = map[string]string{
	"aws":   "eks-",
	"gcp":   "gke-",
	"azure": "aks-",
}

// t2ValidateClusterName asserts the provider-reported `cluster_name` is the cluster THIS
// run provisioned (proving the post-apply spine ran AND that we are looking at our own,
// uniquely-named cluster — never a stale one). Naming differs per template `locals.tf`:
//
//   - hetzner / alibaba: exactly `<project>-<env>` (also the label the runner stamps).
//   - aws / gcp / azure: `<kind>-<regionShort>-<env>-<project>` (e.g.
//     `eks-ue1-<env>-<project>`). The region-short prefix is template-internal and NOT
//     uniqueness-bearing; replicating the 40-row region maps here would just drift from
//     the templates. So we assert the two parts that ARE meaningful and non-vacuous: the
//     resource-kind prefix (proves the right kind of cluster) AND the `-<env>-<project>`
//     suffix (env is `<run_id>-<attempt>`, globally unique per run — proves it is OUR
//     cluster). This is exact enough to fail a stale/misnamed cluster, without coupling
//     the harness to the region map.
func t2ValidateClusterName(provider, project, env, got string) error {
	if strings.TrimSpace(got) == "" {
		return fmt.Errorf("cluster_name is empty — the post-apply spine was SKIPPED")
	}
	if prefix, ok := t2ClusterKindPrefix[provider]; ok {
		suffix := "-" + env + "-" + project
		if !strings.HasPrefix(got, prefix) || !strings.HasSuffix(got, suffix) {
			return fmt.Errorf("cluster_name = %q, want %s<regionShort>%s (template locals.tf naming)", got, prefix, suffix)
		}
		return nil
	}
	// Talos (hetzner) + ACK (alibaba): bare `<project>-<env>`, an exact match.
	if want := project + "-" + env; got != want {
		return fmt.Errorf("cluster_name = %q, want %q", got, want)
	}
	return nil
}

// t2CostShapeRequired is the set of clouds whose TEMPLATE default node shape is expensive
// (or unverified) enough that a real e2e run MUST pin a cheapest-shape override rather than
// inherit it — e.g. AWS defaults to m5a.4xlarge×2 SPOT (16 vCPU each, ~$0.30/run) if
// ALETHIA_E2E_CLUSTER_JSON is absent. Hetzner is exempt: its default (cpx22 ×1) is a proven
// cents/run shape (see the HZ-DEFAULTS work). The nightly always injects a per-provider shape;
// this guard makes a missing one a HARD FAIL so a workflow typo or a bare local managed run can
// never silently burn large nodes.
var t2CostShapeRequired = map[string]bool{
	"aws":     true,
	"gcp":     true,
	"azure":   true,
	"alibaba": true,
}

// t2RequireCostShape enforces the cost-shape override for the expensive-default clouds: under
// ALETHIA_E2E_T2_REQUIRE (the nightly) a managed run with no ALETHIA_E2E_CLUSTER_JSON is a HARD
// FAIL. Off CI (REQUIRE unset) it only warns — a local dev spinning a managed cluster on their
// own account is trusted to size it, but is nudged. Returns (fatal bool, msg string).
func t2RequireCostShape(provider string) (fatal bool, msg string) {
	if !t2CostShapeRequired[provider] {
		return false, ""
	}
	if strings.TrimSpace(os.Getenv("ALETHIA_E2E_CLUSTER_JSON")) != "" {
		return false, ""
	}
	msg = fmt.Sprintf("provider %q has an expensive template default node shape but ALETHIA_E2E_CLUSTER_JSON is unset — refusing to provision the default (e.g. AWS m5a.4xlarge×2). Pin a cheapest shape (small instance ×1, single NAT, min disk).", provider)
	return t2RequireIsHard(), msg
}

// t2Truthy reports whether an env value reads as an affirmative flag.
func t2Truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// t2Env returns the trimmed value of key, or def when unset/blank.
func t2Env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
