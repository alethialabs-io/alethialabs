// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"bytes"
	"errors"
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

// The DECISION, tabulated. Every branch, because the one that fires on the day it matters is the
// one nothing else exercises: on a fresh cluster the class does not exist, on a re-deploy it exists
// and agrees, and only on the redeploy AFTER a provisioner change does it differ.
func TestReconcileStorageClassesDecision(t *testing.T) {
	want := storageClassRef{Name: "gp3", Provisioner: "ebs.csi.aws.com", File: "storage-class-gp3.yaml"}

	cases := []struct {
		name       string
		live       liveProvisionerFn
		wantDelete bool
		wantErr    string
	}{
		{
			name: "fresh cluster — the class does not exist yet, so there is nothing to reconcile",
			live: func(string) (string, bool, error) { return "", false, nil },
		},
		{
			name: "re-deploy with the same provisioner — no delete, because deleting would be churn",
			live: func(string) (string, bool, error) { return "ebs.csi.aws.com", true, nil },
		},
		{
			name:       "the provisioner CHANGED — delete, because the apply that follows cannot update it",
			live:       func(string) (string, bool, error) { return "ebs.csi.eks.amazonaws.com", true, nil },
			wantDelete: true,
		},
		{
			// A cluster that cannot answer is one the apply is about to fail against anyway, with a
			// better message. Never silent, but never fatal here either.
			name: "unreadable live state — warn and apply as-is",
			live: func(string) (string, bool, error) { return "", false, errors.New("connection refused") },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var deleted []string
			del := func(n string) error { deleted = append(deleted, n); return nil }
			var out, errOut bytes.Buffer
			if err := reconcileStorageClasses([]storageClassRef{want}, tc.live, del, &out, &errOut); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got := len(deleted) > 0; got != tc.wantDelete {
				t.Fatalf("delete called = %v, want %v (stdout: %s)", got, tc.wantDelete, out.String())
			}
			if tc.wantDelete && !strings.Contains(out.String(), "immutable") {
				t.Errorf("a delete must say WHY in the deploy log; got: %s", out.String())
			}
		})
	}
}

// A delete that fails must be FATAL and must name both provisioners: the apply that follows would
// fail with the API server's message, which names the field but not the reason.
func TestReconcileStorageClassesFailsLoudlyWhenTheDeleteFails(t *testing.T) {
	var out, errOut bytes.Buffer
	err := reconcileStorageClasses(
		[]storageClassRef{{Name: "gp3", Provisioner: "ebs.csi.aws.com"}},
		func(string) (string, bool, error) { return "ebs.csi.eks.amazonaws.com", true, nil },
		func(string) error { return errors.New("forbidden") },
		&out, &errOut,
	)
	if err == nil {
		t.Fatal("a failed delete leaves the apply certain to fail — it must not be swallowed")
	}
	for _, want := range []string{"ebs.csi.aws.com", "ebs.csi.eks.amazonaws.com", "gp3"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error must name %q so the operator can act: %v", want, err)
		}
	}
}

// An unreadable StorageClass is REFUSED, not applied blind — a provisioner mismatch is only
// repairable BEFORE the apply, so guessing here is the one thing that cannot be undone.
func TestReconcileStorageClassesRefusesAnUnreadableClass(t *testing.T) {
	var out, errOut bytes.Buffer
	err := reconcileStorageClasses(
		[]storageClassRef{{Name: "", Provisioner: "", File: "storage-class-gp3.yaml"}},
		func(string) (string, bool, error) {
			t.Fatal("the cluster must not be consulted about a class that could not be read")
			return "", false, nil
		},
		func(string) error {
			t.Fatal("nothing may be deleted on the strength of an unreadable manifest")
			return nil
		},
		&out, &errOut,
	)
	if err == nil || !strings.Contains(err.Error(), "storage-class-gp3.yaml") {
		t.Fatalf("want a refusal naming the file; got %v", err)
	}
}

// The exported entry point over a rendered directory: no StorageClass means no cluster call at all,
// and an unreadable directory is an error rather than a quiet pass. Without these the only covered
// path is the injected one, and the function the deploy actually calls goes unexercised.
func TestReconcileImmutableStorageClassesOverARenderedDir(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "cert-manager.yaml", "apiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: cert-manager\n")
	var out, errOut bytes.Buffer
	// No StorageClass in the render ⇒ nothing to reconcile, and nothing may shell out to kubectl:
	// on a fresh cluster this runs before anything has been applied at all.
	if err := ReconcileImmutableStorageClasses(dir, &out, &errOut); err != nil {
		t.Fatalf("a render with no StorageClass is not an error: %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("nothing to do must say nothing; got %q", out.String())
	}
	if err := ReconcileImmutableStorageClasses(filepath.Join(dir, "does-not-exist"), &out, &errOut); err == nil {
		t.Fatal("an unreadable rendered directory must be an error — a scan that cannot read is not a scan that found nothing")
	}
}

// "the class is not there" and "the cluster could not tell me" are different answers, and reading
// the second as the first would skip the reconcile on exactly the cluster that needed it.
func TestClassifyLiveProvisioner(t *testing.T) {
	cases := []struct {
		name    string
		out     string
		runErr  error
		want    string
		found   bool
		wantErr bool
	}{
		{name: "a class that exists", out: "ebs.csi.aws.com\n", want: "ebs.csi.aws.com", found: true},
		{name: "kubectl's NotFound is absence, not failure", out: `Error from server (NotFound): storageclasses.storage.k8s.io "gp3" not found`, runErr: errors.New("exit status 1")},
		{name: "any other failure is a failure", out: "The connection to the server was refused", runErr: errors.New("exit status 1"), wantErr: true},
		{name: "an empty read on a successful command is absence", out: "\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, found, err := classifyLiveProvisioner([]byte(tc.out), tc.runErr)
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, want error = %v", err, tc.wantErr)
			}
			if got != tc.want || found != tc.found {
				t.Fatalf("got (%q, %v), want (%q, %v)", got, found, tc.want, tc.found)
			}
		})
	}
}
