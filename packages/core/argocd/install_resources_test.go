// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/alethialabs-io/alethialabs/packages/core/catalog"
)

// milliCPU and mebibytes are DELIBERATELY NARROW parsers, not a re-implementation of Kubernetes
// quantities. `k8s.io/apimachinery` is not a dependency of this module and one is not worth adding
// for a test, and a permissive parser would be the wrong tool anyway: what these assert is that the
// values are written in the two spellings the kubelet reads unambiguously (`<n>m` for CPU, `<n>Mi`
// for memory). Anything else fails the test rather than being silently coerced, which is the same
// posture as the values file itself — a quantity the kubelet cannot parse is a pod it rejects.
func milliCPU(t *testing.T, q string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(strings.TrimSuffix(q, "m"), 10, 64)
	if !strings.HasSuffix(q, "m") || err != nil {
		t.Fatalf("cpu request %q is not written as whole millicores (`100m`) — the kubelet rejects a quantity it cannot parse, and this test will not guess at one", q)
	}
	return n
}

func mebibytes(t *testing.T, q string) int64 {
	t.Helper()
	n, err := strconv.ParseInt(strings.TrimSuffix(q, "Mi"), 10, 64)
	if !strings.HasSuffix(q, "Mi") || err != nil {
		t.Fatalf("memory request %q is not written as whole mebibytes (`256Mi`) — `M` is 10^6 and `Mi` is 2^20, and the two silently differ by 5%%", q)
	}
	return n
}

// Everything below is parsed OUT OF THE RENDERED YAML rather than read back off the constants, for
// the reason install_probes_test.go states: a test that asserts `X == X` is true by construction and
// says nothing about what helm receives. The constants appear here only where a value has to be
// compared against something, and then the comparison is against an INDEPENDENT number — the node's
// allocatable capacity — never against the constant itself.
type resourceBlock struct {
	Requests map[string]string `yaml:"requests"`
	Limits   map[string]string `yaml:"limits"`
}

type resourceComponent struct {
	Resources *resourceBlock `yaml:"resources"`
}

func parseResourceValues(t *testing.T) map[string]resourceComponent {
	t.Helper()
	var got map[string]resourceComponent
	if err := yaml.Unmarshal([]byte(InstallResourceValues()), &got); err != nil {
		t.Fatalf("InstallResourceValues is not valid YAML — helm would reject the whole values file: %v\n%s", err, InstallResourceValues())
	}
	return got
}

// TestInstallResourceValuesRequestForRepoServerOnly pins BOTH halves of the decision.
//
// The positive half is the QoS class: repo-server must carry a cpu AND a memory request, because a
// container with neither is BestEffort — it runs at the cgroup CPU-share floor and sits first in the
// node's eviction ranking. That is the mechanism behind #3855's two proximate errors.
//
// The negative half is not tidiness. Requesting for every component would put the capacity back on
// the node that has least to spare and would restore the tie this exists to break, so a values key
// appearing for anything else is a defect, not an improvement.
func TestInstallResourceValuesRequestForRepoServerOnly(t *testing.T) {
	got := parseResourceValues(t)

	if len(got) != 1 {
		t.Fatalf("the values file configures %d component(s), want exactly repoServer: %#v", len(got), got)
	}
	repo, ok := got["repoServer"]
	if !ok {
		t.Fatalf("no `repoServer` key — the component that runs `helm template` is the one that starves: %#v", got)
	}
	if repo.Resources == nil {
		t.Fatal("repoServer carries no `resources` block, so the container stays BestEffort")
	}
	for _, key := range []string{"cpu", "memory"} {
		if repo.Resources.Requests[key] == "" {
			t.Errorf("repoServer has no %s request — QoS is decided per RESOURCE, so a pod missing either one is not Burstable for it", key)
		}
	}
}

// TestInstallResourceValuesSetNoLimits is the asymmetry, asserted as its own case because it is the
// half a reviewer is most likely to "fix".
//
// A CPU limit throttles exactly the `helm template` this exists to let finish; a memory limit
// OOM-kills a large render outright. Both convert a slow render into a failed one — which is the
// defect, not a fix for it. A request is a FLOOR the scheduler honours; a limit is a CEILING the
// kernel enforces, and only the floor was missing.
func TestInstallResourceValuesSetNoLimits(t *testing.T) {
	repo := parseResourceValues(t)["repoServer"]
	if repo.Resources == nil {
		t.Fatal("no resources block at all")
	}
	if len(repo.Resources.Limits) != 0 {
		t.Errorf("the values file sets limits %v — a cpu limit throttles the render this exists to let finish, and a memory limit OOM-kills it", repo.Resources.Limits)
	}
}

// TestInstallResourceValuesFitTheSmallestNodeTheProductOFFERS is the half that stops the fix
// becoming the next defect: a request too large for the node turns a badly-running pod into a
// permanently Pending one, which is strictly worse than what is being fixed.
//
// ── This test USED to be wrong, and the way it was wrong is the point ──
//
// It hardcoded `e2-medium` as "the smallest node the floor runs on" and asserted each request was
// under a QUARTER of that node's allocatable. 100m is 11% of 940m, so it passed — and then e2e run
// 35499891484 put this very pod into Pending on that very node. A quarter of ALLOCATABLE was never
// the right bound, because allocatable is not free: on that run GKE's own system pods had taken more
// than 840m of the 940m before ArgoCD asked for anything.
//
// Two changes follow from that. The node is no longer a literal — it is whatever
// `catalog.ControlPlaneNodeFit` says is the smallest GCP shape the product will now deploy onto, so
// this test cannot go on measuring against a shape the product has stopped offering. And the claim
// is stated honestly: a quarter of allocatable is a SANITY ceiling on the request, not a proof that
// the pod schedules. What actually keeps the pod off a node it does not fit on is the node-fit gate
// in the provisioner, which refuses the apply; this test only stops the request itself growing into
// the thing that breaks a node which would otherwise have been fine.
func TestInstallResourceValuesFitTheSmallestNodeTheProductOFFERS(t *testing.T) {
	c := catalog.MustLoad()

	// Derived, not typed: the smallest gcp shape whose verdict is OK. If the catalog's shapes
	// change, this moves with them.
	var smallest catalog.Instance
	var smallestAlloc int
	for _, in := range c.Compute["gcp"].Instances {
		fit := c.ControlPlaneNodeFit("gcp", in.Value)
		if fit.Verdict != catalog.FitOK {
			continue
		}
		if smallest.Value == "" || fit.AllocatableCPUMilli < smallestAlloc {
			smallest, smallestAlloc = in, fit.AllocatableCPUMilli
		}
	}
	if smallest.Value == "" {
		t.Fatal("no gcp shape in the catalog passes the control-plane fit check — this test has lost its subject, and the product has nothing to deploy onto")
	}
	// A deliberately PESSIMISTIC memory allocatable: GKE's steepest reservation tier (25%, which it
	// applies to the first 4 GiB) charged against the WHOLE node, plus the 100 MiB eviction
	// threshold. The real figure is higher, because the tiers above 4 GiB reserve 20% and then 10%.
	//
	// The approximation is one-directional on purpose. This is a CEILING on a request, so
	// understating the node can only make the bound stricter, never looser — and modelling the real
	// tiers would mean modelling which of them applies, which changed at node-pool version 1.37 and
	// would put a version-dependent formula in a test that has no way to know the version.
	memMiB := int64(smallest.MemoryGB * 1024)
	allocMiB := memMiB - memMiB/4 - 100

	repo := parseResourceValues(t)["repoServer"]
	if repo.Resources == nil {
		t.Fatal("no resources block at all")
	}

	cpu := milliCPU(t, repo.Resources.Requests["cpu"])
	mem := mebibytes(t, repo.Resources.Requests["memory"])

	if limit := int64(smallestAlloc / 4); cpu > limit {
		t.Errorf("the cpu request is %dm, over a quarter of a %s's ~%dm allocatable (%dm) — a request this large competes with kube-system for the node rather than joining it",
			cpu, smallest.Value, smallestAlloc, limit)
	}
	if limit := allocMiB / 4; mem > limit {
		t.Errorf("the memory request is %d MiB, over a quarter of a %s's ~%d MiB allocatable (%d MiB) — the pod could go Pending, which is worse than the starvation being fixed",
			mem, smallest.Value, allocMiB, limit)
	}
	// A zero request is not a small request: it is the BestEffort class this file exists to leave,
	// and it would pass every ceiling above.
	if cpu <= 0 || mem <= 0 {
		t.Errorf("a request of %dm / %d MiB leaves the container BestEffort — the ceilings above cannot see that, because zero is under all of them", cpu, mem)
	}
}

// TestTheSHAPETHATFAILEDIsNowRefusedByTheProduct is the regression that ties this file to the run
// that falsified its old comment.
//
// The comment here used to end "which cannot turn a running pod into a Pending one on any node the
// product offers". That sentence is now TRUE, and it is true because the product stopped offering
// the node — not because anything in this file changed. This test is what makes that dependency
// visible: if `e2-medium` ever becomes deployable again, the claim above silently reverts to being
// false, and this reds instead.
func TestTheSHAPETHATFAILEDIsNowRefusedByTheProduct(t *testing.T) {
	c := catalog.MustLoad()

	if fit := c.ControlPlaneNodeFit("gcp", "e2-medium"); fit.Verdict != catalog.FitTooSmall {
		t.Errorf("e2-medium is %s — the node that put argocd-repo-server into Pending in run 35499891484 is deployable again, and this file's claim about Pending pods is false once more", fit.Verdict)
	}
	if def := c.Compute["gcp"].DefaultInstance; c.ControlPlaneNodeFit("gcp", def).Verdict == catalog.FitTooSmall {
		t.Errorf("the gcp default is %q, a shape this pod cannot schedule on — a user who changes nothing gets the failure", def)
	}
}
