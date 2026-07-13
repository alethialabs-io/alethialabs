// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"gopkg.in/yaml.v3"
)

// decodeDocs parses a (possibly multi-document) manifest into one generic map per document.
func decodeDocs(t *testing.T, manifest string) []map[string]interface{} {
	t.Helper()
	dec := yaml.NewDecoder(strings.NewReader(manifest))
	var docs []map[string]interface{}
	for {
		var m map[string]interface{}
		err := dec.Decode(&m)
		if err != nil {
			break
		}
		if m != nil {
			docs = append(docs, m)
		}
	}
	return docs
}

// labelsOf returns metadata.labels of a decoded resource as string→string (best effort).
func labelsOf(t *testing.T, doc map[string]interface{}) map[string]string {
	t.Helper()
	meta, _ := doc["metadata"].(map[string]interface{})
	raw, _ := meta["labels"].(map[string]interface{})
	out := map[string]string{}
	for k, v := range raw {
		if s, ok := v.(string); ok {
			out[k] = s
		} else {
			t.Errorf("label %q value is not a string: %T", k, v)
		}
	}
	return out
}

var b14Labels = map[string]string{
	"alethia.io/project-id":     "proj-1",
	"alethia.io/environment-id": "env-1",
	"alethia.io/tier":           "prod",
}

func TestInjectCommonLabels_EmptyIsNoop(t *testing.T) {
	in := "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: x\n"
	out, err := InjectCommonLabels(in, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != in {
		t.Errorf("nil labels must return the manifest byte-for-byte:\n%q\n!=\n%q", out, in)
	}
}

func TestInjectCommonLabels_StampsApplicationAndProject(t *testing.T) {
	for _, kind := range []string{"Application", "AppProject"} {
		in := "apiVersion: argoproj.io/v1alpha1\nkind: " + kind + "\nmetadata:\n  name: x\n  namespace: argocd\nspec:\n  project: infra\n"
		out, err := InjectCommonLabels(in, b14Labels)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		got := labelsOf(t, decodeDocs(t, out)[0])
		for k, v := range b14Labels {
			if got[k] != v {
				t.Errorf("%s: label %q = %q, want %q\n%s", kind, k, got[k], v, out)
			}
		}
	}
}

// Only Application/AppProject documents are labelled — a StorageClass/ClusterSecretStore sharing
// the manifest must be passed through untouched.
func TestInjectCommonLabels_LeavesNonArgoKindsAlone(t *testing.T) {
	in := strings.Join([]string{
		"apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: eso\nspec:\n  project: infra",
		"apiVersion: external-secrets.io/v1beta1\nkind: ClusterSecretStore\nmetadata:\n  name: aws\nspec:\n  provider: {}",
	}, "\n---\n")
	out, err := InjectCommonLabels(in, b14Labels)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	docs := decodeDocs(t, out)
	if len(docs) != 2 {
		t.Fatalf("expected 2 docs, got %d:\n%s", len(docs), out)
	}
	byKind := map[string]map[string]interface{}{}
	for _, d := range docs {
		byKind[d["kind"].(string)] = d
	}
	if got := labelsOf(t, byKind["Application"]); got["alethia.io/project-id"] != "proj-1" {
		t.Errorf("Application not labelled: %v", got)
	}
	if meta, ok := byKind["ClusterSecretStore"]["metadata"].(map[string]interface{}); ok {
		if _, hasLabels := meta["labels"]; hasLabels {
			t.Errorf("ClusterSecretStore must not be labelled: %v", meta["labels"])
		}
	}
}

// An existing identity label (alethia.io/managed-by) must never be overwritten by an attribution
// label of the same key.
func TestInjectCommonLabels_NeverClobbersExisting(t *testing.T) {
	in := "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: x\n  labels:\n    alethia.io/managed-by: addon-marketplace\nspec:\n  project: infra\n"
	out, err := InjectCommonLabels(in, map[string]string{
		"alethia.io/managed-by": "SHOULD-NOT-WIN",
		"alethia.io/project-id": "proj-1",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := labelsOf(t, decodeDocs(t, out)[0])
	if got["alethia.io/managed-by"] != "addon-marketplace" {
		t.Errorf("existing label clobbered: %q", got["alethia.io/managed-by"])
	}
	if got["alethia.io/project-id"] != "proj-1" {
		t.Errorf("new label not added: %v", got)
	}
}

func TestInjectCommonLabels_CreatesLabelsWhenAbsent(t *testing.T) {
	// external-secrets-operator.yaml's Application has annotations + finalizers but NO labels block.
	in := "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: eso\n  annotations:\n    argocd.argoproj.io/sync-wave: \"1\"\nspec:\n  project: infra\n"
	out, err := InjectCommonLabels(in, b14Labels)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := labelsOf(t, decodeDocs(t, out)[0])
	if got["alethia.io/project-id"] != "proj-1" {
		t.Errorf("labels not created: %v\n%s", got, out)
	}
}

// The helm.values literal block scalar must survive the yaml.Node round-trip intact — a corrupted
// values block silently breaks every add-on. Render a real add-on Application and compare its values.
func TestInjectCommonLabels_PreservesHelmValues(t *testing.T) {
	manifest, err := RenderAddOnApplication(sampleAddOn())
	if err != nil {
		t.Fatalf("render add-on: %v", err)
	}
	labeled, err := InjectCommonLabels(manifest, b14Labels)
	if err != nil {
		t.Fatalf("inject: %v", err)
	}

	valuesOf := func(m string) string {
		doc := decodeDocs(t, m)[0]
		spec := doc["spec"].(map[string]interface{})
		source := spec["source"].(map[string]interface{})
		helm := source["helm"].(map[string]interface{})
		return helm["values"].(string)
	}
	before, after := valuesOf(manifest), valuesOf(labeled)
	if before != after {
		t.Errorf("helm.values changed by injection:\n--- before ---\n%s\n--- after ---\n%s", before, after)
	}
	// And the values still parse as the original map.
	var vb, va map[string]interface{}
	if err := yaml.Unmarshal([]byte(before), &vb); err != nil {
		t.Fatalf("before values unparseable: %v", err)
	}
	if err := yaml.Unmarshal([]byte(after), &va); err != nil {
		t.Fatalf("after values unparseable: %v", err)
	}
	if !reflect.DeepEqual(vb, va) {
		t.Errorf("helm values semantics changed: %v vs %v", vb, va)
	}
}

// ── Render-path integration: labels actually reach the written manifests ──────────────────────

func classifiedFacts(provider string) *InfraFacts {
	vc := cfg(provider)
	vc.ID = "proj-1"
	vc.EnvironmentID = "env-1"
	vc.Classification = map[string][]string{"tier": {"prod"}}
	return BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name":              "eks-demo",
		"eks_irsa_external_secrets_arn": "arn:aws:iam::acct-123:role/eso",
	}, vc)
}

func TestRenderApplications_StampsClassificationLabels(t *testing.T) {
	files := renderAll(t, classifiedFacts("aws"))

	// The AppProject and an Application both carry the labels...
	for _, name := range []string{"project-infra.yaml", "external-secrets-operator.yaml"} {
		body, ok := files[name]
		if !ok {
			t.Fatalf("%s did not render", name)
		}
		if !strings.Contains(body, "alethia.io/project-id: proj-1") {
			t.Errorf("%s missing project-id label:\n%s", name, body)
		}
		if !strings.Contains(body, "alethia.io/tier: prod") {
			t.Errorf("%s missing tier label", name)
		}
	}

	// ...and the real external-secrets Application's IRSA annotation (inside helm.values) survived,
	// proving the literal block wasn't mangled while the Application was labelled.
	eso := files["external-secrets-operator.yaml"]
	if !strings.Contains(eso, "eks.amazonaws.com/role-arn") {
		t.Errorf("external-secrets IRSA annotation lost after labelling:\n%s", eso)
	}
	// The ClusterSecretStore doc in the same file must NOT be labelled.
	for _, doc := range decodeDocs(t, eso) {
		if doc["kind"] == "ClusterSecretStore" {
			if meta, ok := doc["metadata"].(map[string]interface{}); ok {
				if _, has := meta["labels"]; has {
					t.Errorf("ClusterSecretStore should not be labelled: %v", meta["labels"])
				}
			}
		}
	}
}

func TestRenderManagedAddOns_StampsClassificationLabels(t *testing.T) {
	labels := map[string]string{"alethia.io/project-id": "proj-1", "alethia.io/tier": "prod"}
	dir, err := RenderManagedAddOns([]types.AddOnInstall{sampleAddOn()}, labels)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	defer os.RemoveAll(dir)

	body, err := os.ReadFile(filepath.Join(dir, "addon-kube-prometheus-stack.yaml"))
	if err != nil {
		t.Fatalf("read rendered add-on: %v", err)
	}
	manifest := string(body)
	if !strings.Contains(manifest, "alethia.io/project-id: proj-1") {
		t.Errorf("add-on Application missing classification label:\n%s", manifest)
	}
	// Identity labels the template already sets must remain.
	if !strings.Contains(manifest, "alethia.io/managed-by: addon-marketplace") {
		t.Errorf("add-on lost its managed-by label:\n%s", manifest)
	}
	// The helm.values block (retention knob) must be intact.
	if !strings.Contains(manifest, "retention: 15d") {
		t.Errorf("add-on helm values corrupted:\n%s", manifest)
	}
}
