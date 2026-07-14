// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Untagged unit proof for the T2 provider table (BYOC A0.1): every provider row's
// credential detection, region default + override, timeout defaults, the REQUIRE=1
// fatal-vs-skip decision, and the ALETHIA_E2E_CLUSTER_JSON merge (valid + malformed)
// are exercised WITHOUT a cloud, a token, or the e2e_t2 build tag — so a bare
// `go test ./...` in test/e2e catches a regression in the seam before the nightly does.
//
// The keystone is TestT2HetznerPathUnchanged: it asserts the hetzner row, resolved from
// EXACTLY the env the current nightly sets, produces the SAME effective config the
// pre-table hard-coded path did (region nbg1, cluster-ready "8m", wait 25m, overall ctx
// 40m) — the guard that tonight's nightly behaves bit-for-bit as before.
package e2e

import (
	"testing"
	"time"
)

// allCredEnvVars is every credential env var any provider row reads. Each test clears
// them all first (t.Setenv "") so an ambient AWS_*/ARM_* on the developer's shell or the
// CI runner cannot leak into a "creds absent" assertion.
var allCredEnvVars = []string{
	"HCLOUD_TOKEN",
	"ALETHIA_E2E_AWS_READY", "AWS_ACCESS_KEY_ID", "AWS_ROLE_ARN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"ARM_CLIENT_ID", "ARM_TENANT_ID", "ARM_SUBSCRIPTION_ID",
	"ALICLOUD_ACCESS_KEY", "ALICLOUD_OIDC_TOKEN_FILE", "ALICLOUD_ROLE_ARN",
}

// allResolutionEnvVars is every env knob the resolvers read, cleared before each test so
// the row default is what's under test unless the case sets an override.
var allResolutionEnvVars = []string{
	"ALETHIA_E2E_REGION", "ALETHIA_E2E_HCLOUD_REGION",
	"ALETHIA_CLUSTER_READY_TIMEOUT", "ALETHIA_E2E_T2_WAIT",
	"ALETHIA_E2E_T2_REQUIRE", "ALETHIA_E2E_CLUSTER_JSON",
	"ALETHIA_E2E_ARGO_TIMEOUT",
}

// clearT2Env blanks every credential + resolution env var for a hermetic subtest.
func clearT2Env(t *testing.T) {
	t.Helper()
	for _, k := range allCredEnvVars {
		t.Setenv(k, "")
	}
	for _, k := range allResolutionEnvVars {
		t.Setenv(k, "")
	}
}

// TestT2ProviderTableComplete pins the exact rows the table must expose, so a dropped or
// renamed provider fails loudly.
func TestT2ProviderTableComplete(t *testing.T) {
	want := map[string]struct {
		region       string
		clusterReady string
		waitTimeout  time.Duration
	}{
		"hetzner": {"nbg1", "8m", 25 * time.Minute},
		"aws":     {"us-east-1", "15m", 50 * time.Minute},
		"gcp":     {"europe-west3-a", "15m", 50 * time.Minute},
		"azure":   {"germanywestcentral", "15m", 50 * time.Minute},
		"alibaba": {"eu-central-1", "15m", 50 * time.Minute},
	}
	if len(t2ProviderTable) != len(want) {
		t.Fatalf("provider table has %d rows, want %d (%s)", len(t2ProviderTable), len(want), t2SupportedProviders())
	}
	for name, w := range want {
		p, ok := t2LookupProvider(name)
		if !ok {
			t.Fatalf("provider %q missing from the table", name)
		}
		if p.defaultRegion != w.region {
			t.Errorf("%s default region = %q, want %q", name, p.defaultRegion, w.region)
		}
		if p.clusterReadyTimeout != w.clusterReady {
			t.Errorf("%s cluster-ready timeout = %q, want %q", name, p.clusterReadyTimeout, w.clusterReady)
		}
		if p.waitTimeout != w.waitTimeout {
			t.Errorf("%s wait timeout = %v, want %v", name, p.waitTimeout, w.waitTimeout)
		}
	}
	if _, ok := t2LookupProvider("digitalocean"); ok {
		t.Fatal("t2LookupProvider returned ok for an unknown provider")
	}
}

// TestT2CredsPresent drives each row's credential detector through its present + absent
// shapes (including alibaba's key-OR-OIDC alternatives and aws's ready-AND-handle pair).
func TestT2CredsPresent(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		env      map[string]string
		wantOK   bool
	}{
		{"hetzner present", "hetzner", map[string]string{"HCLOUD_TOKEN": "tok"}, true},
		{"hetzner absent", "hetzner", nil, false},

		{"aws ready+key", "aws", map[string]string{"ALETHIA_E2E_AWS_READY": "1", "AWS_ACCESS_KEY_ID": "AKIA"}, true},
		{"aws ready+role", "aws", map[string]string{"ALETHIA_E2E_AWS_READY": "true", "AWS_ROLE_ARN": "arn:aws:iam::1:role/x"}, true},
		{"aws ready no handle", "aws", map[string]string{"ALETHIA_E2E_AWS_READY": "1"}, false},
		{"aws handle not ready", "aws", map[string]string{"AWS_ACCESS_KEY_ID": "AKIA"}, false},
		{"aws absent", "aws", nil, false},

		{"gcp present", "gcp", map[string]string{"GOOGLE_APPLICATION_CREDENTIALS": "/tmp/key.json"}, true},
		{"gcp absent", "gcp", nil, false},

		{"azure complete", "azure", map[string]string{"ARM_CLIENT_ID": "c", "ARM_TENANT_ID": "t", "ARM_SUBSCRIPTION_ID": "s"}, true},
		{"azure partial", "azure", map[string]string{"ARM_CLIENT_ID": "c", "ARM_TENANT_ID": "t"}, false},
		{"azure absent", "azure", nil, false},

		{"alibaba static key", "alibaba", map[string]string{"ALICLOUD_ACCESS_KEY": "LTAI"}, true},
		{"alibaba oidc pair", "alibaba", map[string]string{"ALICLOUD_OIDC_TOKEN_FILE": "/tmp/tok", "ALICLOUD_ROLE_ARN": "acs:ram::1:role/x"}, true},
		{"alibaba oidc file only", "alibaba", map[string]string{"ALICLOUD_OIDC_TOKEN_FILE": "/tmp/tok"}, false},
		{"alibaba absent", "alibaba", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearT2Env(t)
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			p, ok := t2LookupProvider(tc.provider)
			if !ok {
				t.Fatalf("unknown provider %q", tc.provider)
			}
			gotOK, msg := p.credsPresent()
			if gotOK != tc.wantOK {
				t.Fatalf("credsPresent = %v, want %v", gotOK, tc.wantOK)
			}
			if !gotOK && msg == "" {
				t.Error("a missing-creds decision must carry a non-empty message")
			}
		})
	}
}

// TestT2ResolveRegion covers the default, the generalized override, the hetzner-only
// legacy fallback, and that the legacy name is IGNORED for the other clouds.
func TestT2ResolveRegion(t *testing.T) {
	cases := []struct {
		name     string
		provider string
		env      map[string]string
		want     string
	}{
		{"hetzner default", "hetzner", nil, "nbg1"},
		{"hetzner legacy fallback", "hetzner", map[string]string{"ALETHIA_E2E_HCLOUD_REGION": "fsn1"}, "fsn1"},
		{"hetzner generalized wins over legacy", "hetzner", map[string]string{"ALETHIA_E2E_REGION": "hel1", "ALETHIA_E2E_HCLOUD_REGION": "fsn1"}, "hel1"},
		{"aws default", "aws", nil, "us-east-1"},
		{"aws override", "aws", map[string]string{"ALETHIA_E2E_REGION": "eu-west-2"}, "eu-west-2"},
		{"aws ignores legacy hcloud name", "aws", map[string]string{"ALETHIA_E2E_HCLOUD_REGION": "fsn1"}, "us-east-1"},
		{"gcp default", "gcp", nil, "europe-west3-a"},
		{"azure default", "azure", nil, "germanywestcentral"},
		{"alibaba override", "alibaba", map[string]string{"ALETHIA_E2E_REGION": "ap-southeast-1"}, "ap-southeast-1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearT2Env(t)
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			p, _ := t2LookupProvider(tc.provider)
			if got := resolveT2Region(p); got != tc.want {
				t.Fatalf("resolveT2Region = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestT2ResolveTimeouts covers the per-provider defaults and the env overrides for both
// the cluster-ready string and the WaitTerminal duration.
func TestT2ResolveTimeouts(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		clearT2Env(t)
		hz, _ := t2LookupProvider("hetzner")
		aws, _ := t2LookupProvider("aws")
		if got := resolveT2ClusterReadyTimeout(hz); got != "8m" {
			t.Errorf("hetzner cluster-ready = %q, want 8m", got)
		}
		if got := resolveT2WaitTimeout(hz); got != 25*time.Minute {
			t.Errorf("hetzner wait = %v, want 25m", got)
		}
		if got := resolveT2ClusterReadyTimeout(aws); got != "15m" {
			t.Errorf("aws cluster-ready = %q, want 15m", got)
		}
		if got := resolveT2WaitTimeout(aws); got != 50*time.Minute {
			t.Errorf("aws wait = %v, want 50m", got)
		}
	})
	t.Run("overrides win", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_CLUSTER_READY_TIMEOUT", "20m")
		t.Setenv("ALETHIA_E2E_T2_WAIT", "70m")
		hz, _ := t2LookupProvider("hetzner")
		if got := resolveT2ClusterReadyTimeout(hz); got != "20m" {
			t.Errorf("override cluster-ready = %q, want 20m", got)
		}
		if got := resolveT2WaitTimeout(hz); got != 70*time.Minute {
			t.Errorf("override wait = %v, want 70m", got)
		}
	})
	t.Run("malformed wait falls back to default", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_T2_WAIT", "not-a-duration")
		hz, _ := t2LookupProvider("hetzner")
		if got := resolveT2WaitTimeout(hz); got != 25*time.Minute {
			t.Errorf("malformed override wait = %v, want the 25m default", got)
		}
	})
}

// TestT2RequireDecision proves ALETHIA_E2E_T2_REQUIRE flips a missing prerequisite from
// a clean skip (unset) to a HARD FAIL (truthy) — the vacuity defense.
func TestT2RequireDecision(t *testing.T) {
	cases := []struct {
		val  string
		hard bool
	}{
		{"", false}, {"0", false}, {"false", false}, {"no", false},
		{"1", true}, {"true", true}, {"yes", true}, {"on", true}, {"TRUE", true},
	}
	for _, tc := range cases {
		t.Run("REQUIRE="+tc.val, func(t *testing.T) {
			clearT2Env(t)
			t.Setenv("ALETHIA_E2E_T2_REQUIRE", tc.val)
			if got := t2RequireIsHard(); got != tc.hard {
				t.Fatalf("t2RequireIsHard(%q) = %v, want %v", tc.val, got, tc.hard)
			}
		})
	}
}

// TestT2MergeClusterJSON covers the no-op (absent env), a valid object merge into an
// empty and a pre-seeded cluster block, and — the vacuity defense — that malformed or
// non-object JSON is a LOUD error rather than a silent wrong-shape provision.
func TestT2MergeClusterJSON(t *testing.T) {
	t.Run("absent is a no-op", func(t *testing.T) {
		clearT2Env(t)
		snap := map[string]any{"provider": "aws"}
		if err := t2MergeClusterJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := snap["cluster"]; ok {
			t.Error("absent CLUSTER_JSON must not add a cluster block")
		}
	})
	t.Run("valid object merges into empty snapshot", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `{"instance_types":["t3.small"],"node_desired_size":2}`)
		snap := map[string]any{"provider": "aws"}
		if err := t2MergeClusterJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		cluster, ok := snap["cluster"].(map[string]any)
		if !ok {
			t.Fatalf("cluster block missing/wrong type: %#v", snap["cluster"])
		}
		if got := cluster["node_desired_size"]; got != float64(2) {
			t.Errorf("node_desired_size = %v, want 2", got)
		}
		types, ok := cluster["instance_types"].([]any)
		if !ok || len(types) != 1 || types[0] != "t3.small" {
			t.Errorf("instance_types = %#v, want [t3.small]", cluster["instance_types"])
		}
	})
	t.Run("merges over a pre-seeded cluster block", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `{"node_desired_size":3}`)
		snap := map[string]any{
			"cluster": map[string]any{"cluster_version": "1.30", "node_desired_size": float64(1)},
		}
		if err := t2MergeClusterJSON(snap); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		cluster := snap["cluster"].(map[string]any)
		if cluster["cluster_version"] != "1.30" {
			t.Errorf("pre-seeded key was dropped: %#v", cluster)
		}
		if cluster["node_desired_size"] != float64(3) {
			t.Errorf("override did not win: node_desired_size = %v", cluster["node_desired_size"])
		}
	})
	t.Run("malformed JSON is a loud error", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `{not valid json`)
		if err := t2MergeClusterJSON(map[string]any{}); err == nil {
			t.Fatal("malformed CLUSTER_JSON must be a loud error, got nil")
		}
	})
	t.Run("non-object JSON is a loud error", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("ALETHIA_E2E_CLUSTER_JSON", `[1,2,3]`)
		if err := t2MergeClusterJSON(map[string]any{}); err == nil {
			t.Fatal("a JSON array must be rejected (cluster override must be an object)")
		}
	})
}

// TestT2HetznerPathUnchanged is the keystone parity guard: resolving the hetzner row from
// EXACTLY the env the current nightly sets must reproduce the pre-table hard-coded config
// (region nbg1, cluster-ready "8m", wait 25m, overall ctx 40m, creds present). If a
// future edit drifts any of these, tonight's nightly would change behavior — and this
// fails first. It also proves that adding ALETHIA_E2E_REGION=nbg1 (the workflow change in
// this PR) leaves the resolved region identical.
func TestT2HetznerPathUnchanged(t *testing.T) {
	hz, ok := t2LookupProvider("hetzner")
	if !ok {
		t.Fatal("hetzner row missing")
	}

	// The pre-table constants the hard-coded path used.
	const (
		wantRegion       = "nbg1"
		wantClusterReady = "8m"
		wantWait         = 25 * time.Minute
		wantOverallCtx   = 40 * time.Minute // deploy wait 25m + argo 8m + 7m headroom
	)

	t.Run("current workflow env (legacy region name)", func(t *testing.T) {
		clearT2Env(t)
		// Exactly what e2e-nightly.yml sets today for the hetzner matrix row.
		t.Setenv("HCLOUD_TOKEN", "fake-token-value")
		t.Setenv("ALETHIA_E2E_HCLOUD_REGION", "nbg1")
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")

		if credsOK, _ := hz.credsPresent(); !credsOK {
			t.Fatal("hetzner creds should be present with HCLOUD_TOKEN set")
		}
		if got := resolveT2Region(hz); got != wantRegion {
			t.Errorf("region = %q, want %q", got, wantRegion)
		}
		if got := resolveT2ClusterReadyTimeout(hz); got != wantClusterReady {
			t.Errorf("cluster-ready = %q, want %q", got, wantClusterReady)
		}
		wait := resolveT2WaitTimeout(hz)
		if wait != wantWait {
			t.Errorf("wait = %v, want %v", wait, wantWait)
		}
		if got := wait + ArgoAssertTimeout() + 7*time.Minute; got != wantOverallCtx {
			t.Errorf("overall ctx = %v, want %v", got, wantOverallCtx)
		}
		if !t2RequireIsHard() {
			t.Error("REQUIRE=1 must make a missing prereq a hard fail")
		}
	})

	t.Run("new workflow env (generalized region name) is identical", func(t *testing.T) {
		clearT2Env(t)
		t.Setenv("HCLOUD_TOKEN", "fake-token-value")
		t.Setenv("ALETHIA_E2E_REGION", "nbg1") // what this PR adds to the workflow
		t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")

		if got := resolveT2Region(hz); got != wantRegion {
			t.Errorf("region = %q, want %q", got, wantRegion)
		}
		if got := resolveT2ClusterReadyTimeout(hz); got != wantClusterReady {
			t.Errorf("cluster-ready = %q, want %q", got, wantClusterReady)
		}
		if got := resolveT2WaitTimeout(hz); got != wantWait {
			t.Errorf("wait = %v, want %v", got, wantWait)
		}
	})
}

// TestT2ValidateClusterName pins the per-provider cluster-name check (BYOC A0.1 seam for
// the AWS/GCP/Azure waves): Talos/ACK are an exact `<project>-<env>`; EKS/GKE/AKS are the
// `<kind>-<regionShort>-<env>-<project>` shape asserted by kind-prefix + unique suffix.
// The negative cases prove it is NOT vacuous — a stale/misnamed/wrong-kind name fails.
func TestT2ValidateClusterName(t *testing.T) {
	const project, env = "alethia-nl", "12345-1"
	cases := []struct {
		name          string
		provider, got string
		wantOK        bool
	}{
		// Bare-name clouds (exact match, mirrors the runner label).
		{"hetzner exact", "hetzner", "alethia-nl-12345-1", true},
		{"alibaba exact", "alibaba", "alethia-nl-12345-1", true},
		{"hetzner wrong", "hetzner", "alethia-nl-99999-9", false},
		{"hetzner empty", "hetzner", "", false},
		// EKS/GKE/AKS: kind prefix + unique `-<env>-<project>` suffix, any regionShort.
		{"aws ue1", "aws", "eks-ue1-12345-1-alethia-nl", true},
		{"aws ec1", "aws", "eks-ec1-12345-1-alethia-nl", true},
		{"gcp ew3", "gcp", "gke-ew3-12345-1-alethia-nl", true},
		{"azure gwc", "azure", "aks-gwc-12345-1-alethia-nl", true},
		// Non-vacuity: wrong kind, wrong run (stale), missing suffix, empty.
		{"aws wrong kind", "aws", "gke-ue1-12345-1-alethia-nl", false},
		{"aws stale env", "aws", "eks-ue1-99999-9-alethia-nl", false},
		{"aws wrong project", "aws", "eks-ue1-12345-1-other", false},
		{"aws no suffix", "aws", "eks-ue1", false},
		{"aws empty", "aws", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := t2ValidateClusterName(tc.provider, project, env, tc.got)
			if tc.wantOK && err != nil {
				t.Fatalf("t2ValidateClusterName(%s, %q) = %v, want ok", tc.provider, tc.got, err)
			}
			if !tc.wantOK && err == nil {
				t.Fatalf("t2ValidateClusterName(%s, %q) = ok, want error", tc.provider, tc.got)
			}
		})
	}
}

// TestT2RequireCostShape covers the cost guard (BYOC F4): managed clouds must pin a cheapest
// shape via ALETHIA_E2E_CLUSTER_JSON; missing it is fatal ONLY under REQUIRE. Hetzner is
// exempt (proven cents/run default).
func TestT2RequireCostShape(t *testing.T) {
	cases := []struct {
		name               string
		provider           string
		clusterJSON        string
		require            bool
		wantFatal, wantMsg bool
	}{
		{"aws no shape, require ⇒ fatal", "aws", "", true, true, true},
		{"aws no shape, local ⇒ warn only", "aws", "", false, false, true},
		{"aws with shape ⇒ ok", "aws", `{"instance_types":["t3.large"]}`, true, false, false},
		{"gcp no shape, require ⇒ fatal", "gcp", "", true, true, true},
		{"azure no shape, require ⇒ fatal", "azure", "", true, true, true},
		{"alibaba no shape, require ⇒ fatal", "alibaba", "", true, true, true},
		{"hetzner exempt (no shape, require)", "hetzner", "", true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearT2Env(t)
			if tc.clusterJSON != "" {
				t.Setenv("ALETHIA_E2E_CLUSTER_JSON", tc.clusterJSON)
			}
			if tc.require {
				t.Setenv("ALETHIA_E2E_T2_REQUIRE", "1")
			}
			fatal, msg := t2RequireCostShape(tc.provider)
			if fatal != tc.wantFatal {
				t.Errorf("fatal = %v, want %v", fatal, tc.wantFatal)
			}
			if (msg != "") != tc.wantMsg {
				t.Errorf("msg present = %v, want %v (msg=%q)", msg != "", tc.wantMsg, msg)
			}
		})
	}
}
