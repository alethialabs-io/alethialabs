// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The half that has to be right without a cluster: does the scan FIND the StorageClass this deploy
// is about to apply, and does it read the field the API server will refuse to update?
//
// A scan that silently matches nothing turns ReconcileImmutableStorageClasses into a no-op that
// reads like a safeguard — which is worse than not having it, because the next person sees the call
// and stops looking.
func TestStorageClassesInManifestsFindsTheRenderedClass(t *testing.T) {
	dir := t.TempDir()
	// The real shape: this is what infra/templates/argocd/storage-class-gp3.yaml renders to, comment
	// block and all, since the comment names BOTH driver names deliberately.
	write(t, dir, "storage-class-gp3.yaml", `apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
allowVolumeExpansion: true
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
parameters:
  type: gp3
  encrypted: "true"
`)
	// An Application, which must NOT be picked up: it also has `metadata.name`, and a scan keyed on
	// that alone would return every rendered file.
	write(t, dir, "cert-manager.yaml", `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: cert-manager
  namespace: argocd
spec:
  project: infra
`)

	got, err := storageClassesInManifests(dir)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want exactly the one StorageClass, got %d: %+v", len(got), got)
	}
	if got[0].Name != "gp3" || got[0].Provisioner != "ebs.csi.aws.com" {
		t.Fatalf("want gp3/ebs.csi.aws.com, got %q/%q", got[0].Name, got[0].Provisioner)
	}
	if got[0].File != "storage-class-gp3.yaml" {
		t.Errorf("the file is named so a refusal can point at it; got %q", got[0].File)
	}
}

// THE REAL TEMPLATE, rendered by the real renderer. The fixture above proves the parser; this
// proves the parser and the template still agree — which is the pair that actually has to hold, and
// the half a fixture can never check.
func TestStorageClassesInManifestsReadsTheRealAWSRender(t *testing.T) {
	files := renderAll(t, BuildFromOutputs(map[string]interface{}{
		"eks_cluster_name": "eks-demo",
	}, cfg("aws")))
	doc, ok := files["storage-class-gp3.yaml"]
	if !ok {
		t.Fatal("the aws render no longer contains storage-class-gp3.yaml — this test would otherwise pass having read nothing")
	}
	ref := parseStorageClassDoc(doc)
	if ref == nil {
		t.Fatal("the rendered aws StorageClass was not recognised as one — the reconcile would then silently do nothing")
	}
	if ref.Name == "" || ref.Provisioner == "" {
		t.Fatalf("both fields must be readable from the real render; got name=%q provisioner=%q", ref.Name, ref.Provisioner)
	}
	// Not asserted as a literal here: TestAWSDefaultStorageClassNamesTheDriverTheClusterInstalls
	// owns WHICH provisioner is right, against the tofu that chooses it. This asserts only that the
	// reconcile can READ it, which is the property that makes that other guard actionable.
	if strings.ContainsAny(ref.Provisioner, `"' `) {
		t.Errorf("the provisioner was read with quoting or whitespace attached: %q", ref.Provisioner)
	}
}

// A document that is a StorageClass but whose fields cannot be read must come back with the field
// EMPTY, not be skipped — the caller refuses on that, and "there is no StorageClass here" and "I
// could not read the one that is here" are different facts.
func TestParseStorageClassDocReportsAnUnreadableClassRatherThanSkippingIt(t *testing.T) {
	ref := parseStorageClassDoc("apiVersion: storage.k8s.io/v1\nkind: StorageClass\nmetadata:\n  labels:\n    a: b\n")
	if ref == nil {
		t.Fatal("a StorageClass with no name is still a StorageClass — returning nil hides it from the caller's refusal")
	}
	if ref.Name != "" || ref.Provisioner != "" {
		t.Fatalf("want both fields empty so the caller can refuse; got %q/%q", ref.Name, ref.Provisioner)
	}
	if parseStorageClassDoc("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n") != nil {
		t.Error("a ConfigMap is not a StorageClass")
	}
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
}
