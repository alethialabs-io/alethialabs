// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package compat_test

// This test formalizes the 7 version couplings that used to live only as scattered
// code comments (#1214, epic #1186). Each coupling has ONE source of truth —
// packages/core/compat/matrix.json — and this test fails loudly the moment a live
// value (a Go const, a Dockerfile ARG, or a Hetzner template literal) drifts from
// it. Two kinds of assertion:
//
//   1. Identity — the live version is a version the matrix RECORDS (m.Release /
//      static_couplings). The runtime engine reports an unrecorded version as
//      not_evaluable, never fail, so this existence check is what actually catches
//      "bumped the template/const but not the matrix (or vice-versa)".
//   2. Consistency — the enabled component set, evaluated at the pinned Kubernetes
//      version through the SHIPPED engine (compat.Evaluate), yields no fail. This
//      dogfoods the exact path #1215 (apply gate) and #1218 (config warn) take.
//
// The Go consts are imported (a rename breaks the build — loud by construction);
// the Dockerfile ARGs and Hetzner .tf literals have no Go symbol, so they are
// scraped from the repo files named by the matrix itself.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
	"github.com/alethialabs-io/alethialabs/packages/core/compat"
	"github.com/alethialabs-io/alethialabs/packages/core/infracost"
	"github.com/alethialabs-io/alethialabs/packages/core/tofu"
)

// normVer strips a single leading "v" so "v0.10.39" and "0.10.39" compare equal —
// the matrix records bare semver; some Go consts / release tags carry the v.
func normVer(s string) string { return strings.TrimPrefix(strings.TrimSpace(s), "v") }

// repoRoot walks up from the test's working directory to the monorepo root,
// identified by go.work. Returns "" when not in a monorepo checkout (the
// file-scraping assertions then skip rather than false-alarm).
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// readRepoFile reads a repo-root-relative coupling source. A missing file is a hard
// failure: the coupling source was moved/renamed without updating the matrix +
// this test, which is itself the drift we exist to catch.
func readRepoFile(t *testing.T, root, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("read coupling source %s: %v (source moved? update matrix.json + this test)", rel, err)
	}
	return string(b)
}

// firstMatch returns the first capture group of re in s, failing if the pattern is
// absent (the source's format changed and the coupling is no longer verifiable).
func firstMatch(t *testing.T, s, rel string, re *regexp.Regexp) string {
	t.Helper()
	m := re.FindStringSubmatch(s)
	if m == nil {
		t.Fatalf("pattern %s not found in %s (format changed? re-anchor this coupling)", re, rel)
	}
	return m[1]
}

// assertNoFail fails the test if any control in the report is a hard fail — the
// enabled set is incompatible with the pinned Kubernetes version.
func assertNoFail(t *testing.T, rep *compat.Report) {
	t.Helper()
	for _, c := range rep.Controls {
		if c.Status == compat.StatusFail {
			t.Errorf("compat control %s FAILED: %+v", c.ID, c.Findings)
		}
	}
}

// TestCouplingArgoCD locks the ArgoCD chart ↔ Kubernetes coupling (#1165): the
// installer's pinned chart version must be a recorded matrix release, and it must
// be compatible with the Kubernetes minor every project template defaults to.
func TestCouplingArgoCD(t *testing.T) {
	m := compat.MustLoad()
	ver := argocd.DefaultArgoChartVersion
	rel, ok := m.Release("argocd", ver)
	if !ok {
		t.Fatalf("matrix.json components[argocd] has no release %q — bump the matrix or the const in lockstep", ver)
	}
	if rel.K8sMin == "" {
		t.Errorf("argocd %s: matrix records no k8s_min; the #1165 floor (1.33) must be recorded", ver)
	}
	// Templates default to K8s 1.35 across every cloud (matrix k8s_cloud defaults).
	rep := compat.Evaluate(compat.Subject{
		K8sVersion: "1.35",
		Components: []compat.ComponentRef{{ID: "argocd", Version: ver}},
	})
	assertNoFail(t, rep)
}

// TestStaticCouplings locks each build-time Go-const ↔ Dockerfile-ARG coupling: the
// live Go fallback const, the matrix static_couplings value, and the ARG baked into
// the runner image must all agree (modulo a leading "v"). Iterating the matrix's own
// static_couplings means adding one there forces a Go-const wiring here.
func TestStaticCouplings(t *testing.T) {
	m := compat.MustLoad()
	root := repoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping Dockerfile scrape")
	}

	// The live Go fallback const for each static-coupling id (imported → a rename
	// breaks the build). A coupling id with no entry here is flagged below.
	goConst := map[string]string{
		"tofu":      tofu.DefaultIaCVersion,
		"infracost": infracost.DefaultInfracostVersion,
	}

	for _, c := range m.StaticCouplings {
		t.Run(c.ID, func(t *testing.T) {
			live, wired := goConst[c.ID]
			if !wired {
				t.Fatalf("static coupling %q has no Go const wired in this test — add it to goConst", c.ID)
			}
			if normVer(live) != normVer(c.Value) {
				t.Errorf("Go const = %q, matrix static_couplings[%s].value = %q", live, c.ID, c.Value)
			}
			// The ARG baked into the runner image must match the matrix value too.
			df := readRepoFile(t, root, c.Dockerfile)
			argRe := regexp.MustCompile(`(?m)^ARG ` + regexp.QuoteMeta(c.DockerfileArg) + `=(\S+)`)
			arg := firstMatch(t, df, c.Dockerfile, argRe)
			if normVer(arg) != normVer(c.Value) {
				t.Errorf("%s ARG %s = %q, matrix value = %q", c.Dockerfile, c.DockerfileArg, arg, c.Value)
			}
		})
	}
}

// TestHetznerTemplateCouplings locks the Hetzner template's Talos / Cilium / CCM /
// CSI versions and the Kubernetes minor they are pinned in lockstep with. Each
// component version must be a recorded matrix release, and the whole enabled set,
// evaluated at the template's pinned kubernetes_version through the shipped engine,
// must not fail — the real invariant (e.g. raising k8s past Cilium's 1.35 ceiling
// would fail here).
func TestHetznerTemplateCouplings(t *testing.T) {
	m := compat.MustLoad()
	root := repoRoot(t)
	if root == "" {
		t.Skip("go.work not found; not in a monorepo checkout — skipping template scrape")
	}
	const base = "infra/templates/project/hetzner"
	vars := readRepoFile(t, root, base+"/variables.tf")
	cil := readRepoFile(t, root, base+"/cilium.tf")
	csi := readRepoFile(t, root, base+"/csi.tf")

	// tfVarDefault extracts a `variable "<name>" { ... default = "<v>" }` default.
	tfVarDefault := func(name, src, rel string) string {
		return firstMatch(t, src, rel, regexp.MustCompile(
			`variable "`+regexp.QuoteMeta(name)+`"\s*\{[^}]*?default\s*=\s*"([^"]+)"`))
	}
	// tfLocal extracts a `<name> = "<v>"` local assignment.
	tfLocal := func(name, src, rel string) string {
		return firstMatch(t, src, rel, regexp.MustCompile(
			`(?m)^\s*`+regexp.QuoteMeta(name)+`\s*=\s*"([^"]+)"`))
	}

	talosVer := tfVarDefault("talos_version", vars, base+"/variables.tf")
	kubeVer := tfVarDefault("kubernetes_version", vars, base+"/variables.tf")
	ciliumVer := tfLocal("cilium_version", cil, base+"/cilium.tf")
	ccmVer := tfLocal("hcloud_ccm_version", cil, base+"/cilium.tf")
	csiVer := tfLocal("hcloud_csi_version", csi, base+"/csi.tf")

	components := []compat.ComponentRef{
		{ID: "talos", Version: talosVer},
		{ID: "cilium", Version: ciliumVer},
		{ID: "hcloud-ccm", Version: ccmVer},
		{ID: "hcloud-csi", Version: csiVer},
	}

	// Identity: every template version is a version the matrix records.
	for _, ref := range components {
		if _, ok := m.Release(ref.ID, ref.Version); !ok {
			t.Errorf("matrix.json components[%s] has no release %q — bump the matrix or the template in lockstep",
				ref.ID, ref.Version)
		}
	}

	// Consistency: the enabled set at the pinned Kubernetes version must not fail.
	rep := compat.Evaluate(compat.Subject{
		Providers:  []string{"hetzner"},
		K8sVersion: kubeVer,
		Components: components,
	})
	assertNoFail(t, rep)
}
