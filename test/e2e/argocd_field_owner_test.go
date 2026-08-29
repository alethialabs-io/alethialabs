// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PURE tests for server-side-apply FIELD OWNERSHIP — the thing that answers "which field did the
// chart not author?" without an ArgoCD API, a session token or a port-forward.
//
// These exist because the previous diagnostic did not survive contact with a real run.
// hetzner/addons run 32949217522 dumped five CustomResourceDefinitions as live JSON, each truncated
// at 3000 bytes somewhere inside `spec.versions[].schema.openAPIV3Schema`, and named no field on any
// of them. A whole cloud run bought no answer. The replacement had better be tested on the shapes
// the apiserver actually emits.

package e2e

import (
	"errors"
	"strings"
	"testing"
)

// The apiserver's real encoding, taken from a live object: `f:` for a field, `k:{…}` for a
// keyed list entry, and a bare `.` marking "this node itself is owned".
const managedFieldsObject = `{
  "metadata": {
    "managedFields": [
      {
        "manager": "argocd-controller",
        "operation": "Apply",
        "fieldsV1": {
          "f:spec": {
            "f:replicas": {},
            "f:template": {
              "f:spec": {
                "f:containers": {
                  "k:{\"name\":\"app\"}": { ".": {}, "f:image": {} }
                }
              }
            }
          }
        }
      },
      {
        "manager": "kube-apiserver",
        "operation": "Update",
        "fieldsV1": {
          "f:spec": { "f:conversion": { "f:strategy": {} } }
        }
      },
      {
        "manager": "kube-controller-manager",
        "operation": "Update",
        "fieldsV1": {
          "f:status": { "f:terminatingReplicas": {} }
        }
      }
    ]
  }
}`

func TestForeignFieldOwnersExcludesArgoCD(t *testing.T) {
	byManager, _, err := foreignFieldOwners([]byte(managedFieldsObject))
	if err != nil {
		t.Fatalf("parsing managedFields: %v", err)
	}

	// THE ASSERTION THAT MATTERS. A field ArgoCD applied is one the chart authored, so listing it as
	// a candidate would send somebody to write an ignoreDifferences entry for a field that is
	// working correctly — and an ignore on a real field hides genuine drift.
	if _, ours := byManager["argocd-controller"]; ours {
		t.Error("ArgoCD's own fields were reported as foreign — every candidate would be noise")
	}
	if len(byManager) != 2 {
		t.Fatalf("want 2 foreign managers, got %d: %v", len(byManager), byManager)
	}
	if got := byManager["kube-apiserver"]; len(got) != 1 || got[0] != ".spec.conversion.strategy" {
		t.Errorf("kube-apiserver paths = %v, want [.spec.conversion.strategy]", got)
	}
	if got := byManager["kube-controller-manager"]; len(got) != 1 || got[0] != ".status.terminatingReplicas" {
		t.Errorf("kube-controller-manager paths = %v, want [.status.terminatingReplicas]", got)
	}
}

// ArgoCD's field-manager name has varied across versions, so the match is a substring. If it ever
// stopped matching, EVERY chart-authored field would be reported as a candidate — a dump that is
// entirely noise, and confidently so.
func TestArgoManagerMatchIsVersionTolerant(t *testing.T) {
	for _, name := range []string{
		"argocd-controller",
		"argocd-application-controller",
		"argocd-controller-ssa",
		"ArgoCD-Controller",
	} {
		if !isArgoManager(name) {
			t.Errorf("%q is an ArgoCD manager and was not recognised", name)
		}
	}
	for _, name := range []string{"kube-apiserver", "kube-controller-manager", "helm", "kubectl-client-side-apply"} {
		if isArgoManager(name) {
			t.Errorf("%q is NOT ArgoCD's and was treated as ours — its fields would be hidden", name)
		}
	}
}

func TestFlattenFieldsV1RendersActionablePaths(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{
			// A bare "." means the node itself is owned; it adds no path. Rendering it would produce
			// `.spec.replicas.`, which is not a path anyone can act on.
			name: "a self-ownership marker adds no path",
			in:   `{"f:spec":{"f:replicas":{".":{}}}}`,
			want: []string{".spec.replicas"},
		},
		{
			name: "a leaf with no children is itself the path",
			in:   `{"f:spec":{"f:replicas":{}}}`,
			want: []string{".spec.replicas"},
		},
		{
			// WHICH element differs is often the whole answer on a containers[] or versions[] list,
			// so the selector is kept verbatim rather than collapsed to `[]`.
			name: "a keyed list entry keeps its selector",
			in:   `{"f:spec":{"f:containers":{"k:{\"name\":\"app\"}":{"f:image":{}}}}}`,
			want: []string{`.spec.containers[k:{"name":"app"}].image`},
		},
		{
			name: "an indexed list entry keeps its index",
			in:   `{"f:spec":{"f:versions":{"i:0":{"f:served":{}}}}}`,
			want: []string{".spec.versions[i:0].served"},
		},
		{
			name: "nothing owned yields no paths, rather than a bare prefix",
			in:   `{}`,
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := flattenOne(t, tc.in)
			if strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Errorf("got %v, want %v", got, tc.want)
			}
		})
	}
}

// A malformed object must not be reported as "nothing foreign found". "Could not read it" and "it
// had nothing interesting" are different facts with different remedies, and the dumper prints them
// differently only if this layer keeps them apart.
func TestForeignFieldOwnersFailsLoudlyOnGarbage(t *testing.T) {
	if _, _, err := foreignFieldOwners([]byte("not json at all")); err == nil {
		t.Fatal("unparseable input reported success — it would print as 'no foreign default to blame'")
	}
}

// An object with NO managedFields must be DISTINGUISHABLE from an object all of whose fields belong
// to ArgoCD. It was not, and that is the whole defect: `kubectl get -o json` strips managedFields
// unless `--show-managed-fields` is passed, so this probe parsed an empty list on EVERY object,
// found zero foreign managers every time, and printed "every field is ArgoCD-owned — no foreign
// default to blame" for seven Applications across four paid runs. The sentence was true of nothing.
//
// The count is what tells them apart, so the count is what is asserted.
func TestForeignFieldOwnersOnAnObjectWithoutManagedFields(t *testing.T) {
	byManager, total, err := foreignFieldOwners([]byte(`{"metadata":{"name":"x"}}`))
	if err != nil {
		t.Fatalf("an object without managedFields is not an error: %v", err)
	}
	if len(byManager) != 0 {
		t.Errorf("want no foreign owners, got %v", byManager)
	}
	if total != 0 {
		t.Errorf("an object with no managedFields must report ZERO entries, got %d", total)
	}
}

// The other side of that distinction: an object whose ONLY manager is ArgoCD has no foreign owner
// AND a non-zero entry count. Same empty map as the case above, different `total` — which is the
// signal the caller branches on.
func TestForeignFieldOwnersCountsArgoOnlyOwnership(t *testing.T) {
	obj := `{"metadata":{"managedFields":[{"manager":"argocd-controller","fieldsV1":{"f:spec":{}}}]}}`
	byManager, total, err := foreignFieldOwners([]byte(obj))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}
	if len(byManager) != 0 {
		t.Errorf("argocd is not a foreign owner, got %v", byManager)
	}
	if total != 1 {
		t.Errorf("want 1 managedFields entry counted, got %d — this is the number that separates "+
			"'ArgoCD owns everything' from 'nothing was read'", total)
	}
}

// The shape the rig measured, so the fixture is a MEASUREMENT rather than an invention: keda 2.15.1
// on a kind cluster leaves `manager=keda` owning exactly the three webhooks' caBundle. That is the
// field azure/addons run 33243601159 died on, and the probe called it ArgoCD-owned.
func TestForeignFieldOwnersFindsKedasCABundle(t *testing.T) {
	// The `k:{...}` set-key form is what the apiserver actually writes for a keyed list, so it is
	// kept verbatim; the quotes inside it are escaped, which is why this is not a raw string.
	obj := "{\"metadata\":{\"managedFields\":[" +
		"{\"manager\":\"helm\",\"fieldsV1\":{\"f:webhooks\":{" +
		"\"k:{\\\"name\\\":\\\"vscaledobject.kb.io\\\"}\":{\"f:rules\":{}}}}}," +
		"{\"manager\":\"keda\",\"fieldsV1\":{\"f:webhooks\":{" +
		"\"k:{\\\"name\\\":\\\"vscaledobject.kb.io\\\"}\":{\"f:clientConfig\":{\"f:caBundle\":{}}}," +
		"\"k:{\\\"name\\\":\\\"vstriggerauthentication.kb.io\\\"}\":{\"f:clientConfig\":{\"f:caBundle\":{}}}," +
		"\"k:{\\\"name\\\":\\\"vsclustertriggerauthentication.kb.io\\\"}\":{\"f:clientConfig\":{\"f:caBundle\":{}}}}}}" +
		"]}}"
	byManager, total, err := foreignFieldOwners([]byte(obj))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}
	if total != 2 {
		t.Fatalf("want 2 managedFields entries, got %d", total)
	}
	paths, ok := byManager["keda"]
	if !ok {
		t.Fatalf("keda must be reported as a foreign owner; got %v", byManager)
	}
	var sawCABundle int
	for _, p := range paths {
		if strings.Contains(p, "caBundle") {
			sawCABundle++
		}
	}
	if sawCABundle != 3 {
		t.Errorf("want all three webhooks' caBundle named, got %d in %v", sawCABundle, paths)
	}
}

// flattenOne drives flattenFieldsV1 through foreignFieldOwners, so the test exercises the real
// entry point rather than a shape only this file constructs.
func flattenOne(t *testing.T, fieldsV1 string) []string {
	t.Helper()
	obj := `{"metadata":{"managedFields":[{"manager":"kube-apiserver","fieldsV1":` + fieldsV1 + `}]}}`
	byManager, _, err := foreignFieldOwners([]byte(obj))
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}
	return byManager["kube-apiserver"]
}

// A rejected sync must be REPORTED, not merely retried. This is the assertion for the half of the
// `addon-byo-e2e` Missing story that had no signal at all: `_ = cmd.Run()` made "every sync attempt
// was rejected" indistinguishable from "the sync is queued and the chart is slow".
func TestRenderSyncErrorsNamesTheRejectedApps(t *testing.T) {
	// Nothing failed ⇒ nothing printed. A reassuring empty section is its own kind of noise.
	if got := renderSyncErrors(nil); got != "" {
		t.Errorf("no failures rendered %q, want empty", got)
	}
	if got := renderSyncErrors(map[string]error{}); got != "" {
		t.Errorf("an empty map rendered %q, want empty", got)
	}

	out := renderSyncErrors(map[string]error{
		"addon-byo-e2e": errors.New(`sync addon-byo-e2e: exit status 1: Error from server (Forbidden)`),
		"apps":          errors.New(`sync apps: exit status 1: operation already in progress`),
	})
	for _, want := range []string{"addon-byo-e2e", "Forbidden", "apps", "already in progress", "REJECTED"} {
		if !strings.Contains(out, want) {
			t.Errorf("the report drops %q — a remedy needs the reason, not just the app name:\n%s", want, out)
		}
	}
	// Stable order, or two identical runs read as different ones.
	if strings.Index(out, "addon-byo-e2e") > strings.Index(out, "- apps") {
		t.Errorf("apps are not in sorted order:\n%s", out)
	}
}

// A cluster-scoped object can be OutOfSync under more than one Application — a CustomResourceDefinition
// most of all. The dump is CAPPED, so a duplicate does not merely repeat itself: it pushes a genuine
// object behind "… n more not shown". hetzner/addons run 32949217522 had exactly 8 losers against a
// cap of 8, five of them argo-rollouts CRDs, so one duplicate would have cost that run an answer.
func TestRefsForLosersDeduplicatesAcrossApplications(t *testing.T) {
	crd := outOfSyncRef{Group: "apiextensions.k8s.io", Kind: "CustomResourceDefinition", Name: "rollouts.argoproj.io"}
	own := outOfSyncRef{Kind: "StatefulSet", Name: "addon-tempo", Namespace: "tempo"}
	observed := map[string]argoAppState{
		"addon-argo-rollouts": {OutOfSyncRefs: []outOfSyncRef{crd}},
		"addon-kyverno":       {OutOfSyncRefs: []outOfSyncRef{crd}},
		"addon-tempo":         {OutOfSyncRefs: []outOfSyncRef{own, crd}},
	}
	got := refsForLosers(observed, []string{"addon-argo-rollouts", "addon-kyverno", "addon-tempo"})
	if len(got) != 2 {
		t.Fatalf("got %d refs, want 2 (the CRD once, the StatefulSet once): %+v", len(got), got)
	}
	// First occurrence wins, so the dump still follows the loser order the reader sees above it.
	if got[0] != crd || got[1] != own {
		t.Errorf("order not preserved: %+v", got)
	}
}

// The flag that turns this probe from a claim into a measurement. Asserted on the ARGS rather than
// on a rendered string, because the failure mode it guards is silent: without it kubectl returns a
// well-formed object with `metadata.managedFields` simply absent, and every downstream branch reads
// as "nothing foreign here".
func TestForeignOwnerKubectlArgsAskForManagedFields(t *testing.T) {
	args := foreignOwnerKubectlArgs("/kc", "validatingwebhookconfiguration.admissionregistration.k8s.io/keda-admission", "")
	var sawFlag bool
	for _, a := range args {
		if a == "--show-managed-fields" {
			sawFlag = true
		}
	}
	if !sawFlag {
		t.Fatalf("kubectl STRIPS metadata.managedFields without --show-managed-fields, so this probe would "+
			"measure nothing and report 'every field is ArgoCD-owned'. args: %v", args)
	}
	// A cluster-scoped target must not carry -n: `kubectl get <clusterscoped> -n <ns>` is accepted
	// and ignored, but a namespaced target with an EMPTY namespace would silently read the default
	// namespace, so the branch is asserted rather than assumed.
	for _, a := range args {
		if a == "-n" {
			t.Fatalf("no namespace was given, so -n must not appear: %v", args)
		}
	}
	ns := foreignOwnerKubectlArgs("/kc", "deployment.apps/keda-operator", "keda")
	if ns[len(ns)-2] != "-n" || ns[len(ns)-1] != "keda" {
		t.Fatalf("a namespaced target must carry its namespace: %v", ns)
	}
}
