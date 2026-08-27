// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #2837: Talos enforces PodSecurity `baseline` on every namespace but kube-system, and baseline
// forbids privileged containers, host namespaces and hostPath volumes. A chart needing any of those
// has its DaemonSet ADMITTED and its pods REJECTED — zero pods, Progressing forever, and nothing in
// the Application saying why. falco and kube-prometheus-stack's node-exporter both hit it.
//
// The add-on declares the level it needs and the renderer labels ITS OWN namespace, so enabling
// falco cannot weaken the namespace next door.

package argocd

import (
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// renderedSyncPolicy pulls the syncPolicy back out of a rendered Application, so these tests assert
// on the STRUCTURE ArgoCD will read rather than on a substring of YAML.
func renderedSyncPolicy(t *testing.T, a types.AddOnInstall) map[string]interface{} {
	t.Helper()
	manifest, err := RenderAddOnApplication(a)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	var doc struct {
		Spec struct {
			SyncPolicy map[string]interface{} `yaml:"syncPolicy"`
		} `yaml:"spec"`
	}
	if err := yaml.Unmarshal([]byte(manifest), &doc); err != nil {
		t.Fatalf("rendered manifest is not valid YAML: %v\n%s", err, manifest)
	}
	return doc.Spec.SyncPolicy
}

func TestPodSecurityLabelsTheNamespace(t *testing.T) {
	a := sampleAddOn()
	a.PodSecurity = "privileged"

	sp := renderedSyncPolicy(t, a)
	meta, ok := sp["managedNamespaceMetadata"].(map[string]interface{})
	if !ok {
		t.Fatalf("no managedNamespaceMetadata in syncPolicy: %#v", sp)
	}
	labels, ok := meta["labels"].(map[string]interface{})
	if !ok {
		t.Fatalf("no labels in managedNamespaceMetadata: %#v", meta)
	}
	if got := labels["pod-security.kubernetes.io/enforce"]; got != "privileged" {
		t.Fatalf("enforce label = %v, want privileged", got)
	}

	// CreateNamespace is what makes the metadata apply at all: ArgoCD labels the namespace it
	// CREATES. Without that option the declaration would render and do nothing.
	opts, _ := sp["syncOptions"].([]interface{})
	var found bool
	for _, o := range opts {
		if s, _ := o.(string); s == "CreateNamespace=true" {
			found = true
		}
	}
	if !found {
		t.Fatalf("CreateNamespace=true missing, so namespace metadata would never be applied: %#v", opts)
	}
}

func TestNoPodSecurityLeavesTheNamespaceAlone(t *testing.T) {
	// The default for every ordinary add-on. Labelling every namespace `privileged` "just in case"
	// would silently disable admission across the cluster, which is the opposite of the fix.
	sp := renderedSyncPolicy(t, sampleAddOn())
	if _, present := sp["managedNamespaceMetadata"]; present {
		t.Fatalf("an add-on declaring no level must not label its namespace: %#v", sp)
	}
}

func TestInvalidPodSecurityLevelIsIgnoredNotRendered(t *testing.T) {
	// A typo must NOT become a namespace label. The API server rejects an unknown enforce level,
	// and that failure would take the whole Application's sync down — turning a harmless mistake in
	// the catalogue into an outage for an add-on that was previously merely unlabelled.
	for _, bad := range []string{"privleged", "PRIVILEGED", "none", "true", "", " privileged"} {
		a := sampleAddOn()
		a.PodSecurity = bad
		sp := renderedSyncPolicy(t, a)
		if _, present := sp["managedNamespaceMetadata"]; present {
			t.Fatalf("level %q was rendered, but only the three upstream levels are valid: %#v", bad, sp)
		}
	}
}

func TestEveryValidPodSecurityLevelRenders(t *testing.T) {
	// Not just privileged: an add-on may want to HARDEN its own namespace, and the same mechanism
	// serves that. If this ever narrows to one level, the type should narrow with it.
	for _, level := range []string{"privileged", "baseline", "restricted"} {
		a := sampleAddOn()
		a.PodSecurity = level
		sp := renderedSyncPolicy(t, a)
		meta, ok := sp["managedNamespaceMetadata"].(map[string]interface{})
		if !ok {
			t.Fatalf("level %q did not render: %#v", level, sp)
		}
		labels, _ := meta["labels"].(map[string]interface{})
		if got := labels["pod-security.kubernetes.io/enforce"]; got != level {
			t.Fatalf("level %q rendered as %v", level, got)
		}
	}
}

func TestPodSecurityDoesNotDisturbTheRestOfTheSpec(t *testing.T) {
	// The label is an addition, not a rewrite: automated sync, ServerSideApply and the sync-wave
	// must survive it untouched.
	a := sampleAddOn()
	a.PodSecurity = "privileged"
	manifest, err := RenderAddOnApplication(a)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	for _, want := range []string{"ServerSideApply=true", "RespectIgnoreDifferences=true", "selfHeal"} {
		if !strings.Contains(manifest, want) {
			t.Fatalf("%q lost from the rendered Application:\n%s", want, manifest)
		}
	}
}

func TestNamespaceMetadataForIsTheOnlyGate(t *testing.T) {
	// Direct unit cover of the helper, so the validity rule is pinned independently of rendering.
	if namespaceMetadataFor("privileged") == nil {
		t.Fatal("valid level returned nil")
	}
	for _, bad := range []string{"", "nope", "Baseline"} {
		if got := namespaceMetadataFor(bad); got != nil {
			t.Fatalf("invalid level %q returned %#v", bad, got)
		}
	}
}
