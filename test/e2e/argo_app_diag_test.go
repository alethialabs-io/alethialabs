// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package e2e

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

// A vcluster Application shaped like the one run 36634781502 left behind, with the operationState
// ArgoCD records when the target namespace does not exist inside the virtual cluster.
const vcAppFailedJSON = `{
  "metadata": {"name": "vc-app-alethia-nl-boutique-staging"},
  "spec": {
    "source": {"repoURL": "https://github.com/alethialabs-io/alethia-examples", "path": "examples/online-boutique/overlays/staging", "targetRevision": "HEAD"},
    "destination": {"name": "boutique-staging", "namespace": "boutique-staging"},
    "syncPolicy": {"automated": {"prune": true, "selfHeal": true}, "syncOptions": ["CreateNamespace=true"]}
  },
  "status": {
    "health": {"status": "Missing"},
    "sync": {"status": "OutOfSync", "revision": "abc123"},
    "operationState": {
      "phase": "Failed",
      "message": "one or more objects failed to apply, reason: namespaces \"boutique-staging\" not found",
      "syncResult": {"resources": [
        {"kind": "Deployment", "namespace": "boutique-staging", "name": "frontend", "status": "SyncFailed", "message": "namespaces \"boutique-staging\" not found"},
        {"kind": "Namespace", "name": "boutique-staging", "status": "Synced"}
      ]}
    },
    "conditions": [{"type": "SyncError", "message": "Failed sync attempt to abc123: one or more objects failed to apply"}]
  }
}`

func TestRenderArgoAppDiagnosisNamesTheCause(t *testing.T) {
	got := renderArgoAppDiagnosis("vc-app-x", []byte(vcAppFailedJSON), nil, "boutique-staging", "https://boutique-staging.vcluster-boutique-staging.svc", nil)
	for _, want := range []string{
		"health=Missing sync=OutOfSync",
		`path="examples/online-boutique/overlays/staging"`,
		"destination: name=boutique-staging server=(none) namespace=boutique-staging",
		"syncPolicy: automated (prune=true selfHeal=true) options=CreateNamespace=true",
		"retry=none",
		"phase=Failed",
		`Deployment/frontend in boutique-staging: SyncFailed namespaces "boutique-staging" not found`,
		"condition SyncError: Failed sync attempt",
		"server=https://boutique-staging.vcluster-boutique-staging.svc (credentials deliberately not read)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("diagnosis is missing %q\n--- got ---\n%s", want, got)
		}
	}
	// A resource that synced fine is noise on a failing path.
	if strings.Contains(got, "Namespace/boutique-staging") {
		t.Errorf("a Synced resource was printed:\n%s", got)
	}
}

func TestRenderArgoAppDiagnosisSaysWhenNotAutomated(t *testing.T) {
	const manual = `{"spec":{"source":{"repoURL":"r","path":"p"},"destination":{"name":"vc"}},"status":{"health":{"status":"Missing"},"sync":{"status":"OutOfSync"}}}`
	got := renderArgoAppDiagnosis("a", []byte(manual), nil, "", "", nil)
	if !strings.Contains(got, "NOT automated") {
		t.Fatalf("an Application with no automated policy must be called out:\n%s", got)
	}
	if !strings.Contains(got, "NO operationState and NO conditions") {
		t.Fatalf("a never-attempted sync must read as such:\n%s", got)
	}
	// No cluster requested → no cluster line.
	if strings.Contains(got, "cluster Secret") {
		t.Fatalf("namespace-tier dump must not mention a cluster Secret:\n%s", got)
	}
}

func TestRenderArgoAppDiagnosisReadFailures(t *testing.T) {
	got := renderArgoAppDiagnosis("a", nil, errors.New("exit status 1"), "vc", "", errors.New("NotFound"))
	if !strings.Contains(got, "could not read the Application (exit status 1)") {
		t.Fatalf("an unreadable Application must say so:\n%s", got)
	}
	if !strings.Contains(got, "argocd/vc: server unreadable (NotFound)") {
		t.Fatalf("an unreadable cluster Secret must say so:\n%s", got)
	}
}

func TestRenderArgoAppDiagnosisIsBounded(t *testing.T) {
	huge := strings.Repeat("x", 50000)
	appJSON := `{"spec":{},"status":{"operationState":{"phase":"Failed","message":"` + huge + `"}}}`
	got := renderArgoAppDiagnosis("a", []byte(appJSON), nil, "", "", nil)
	if len(got) > 4000 {
		t.Fatalf("diagnosis is %d bytes — a single message must be capped", len(got))
	}
	if !strings.Contains(got, "…(truncated)") {
		t.Fatalf("the cut must be marked:\n%.300s", got)
	}
}

func TestDecodeClusterSecretServer(t *testing.T) {
	want := "https://vc.vcluster-vc.svc"
	got, err := decodeClusterSecretServer(base64.StdEncoding.EncodeToString([]byte(want + "\n")))
	if err != nil || got != want {
		t.Fatalf("decode = %q, %v; want %q", got, err, want)
	}
	if _, err := decodeClusterSecretServer("  "); err == nil {
		t.Fatal("an absent data.server must be an error, not an empty server")
	}
	if _, err := decodeClusterSecretServer("%%%"); err == nil {
		t.Fatal("non-base64 must be an error")
	}
}
