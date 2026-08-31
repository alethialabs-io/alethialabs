// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/argocd"
)

// A version-preflight refusal must reach the operator as it was written. RunDeployV2 used to
// prefix every installArgoCD error with "ArgoCD install failed: ", which reads a deliberate
// refusal as a broken chart and sends the operator to the wrong place (#3495).
func TestArgocdInstallErrorKeepsARefusalUnwrapped(t *testing.T) {
	refusal := &argocd.PreflightRefusal{Decision: argocd.ArgoPreflightDecision{
		Verdict: argocd.ArgoPreflightOutOfRange,
		Message: "refusing to install ArgoCD: namespace argocd already runs ArgoCD v3.1.8",
	}}

	got := argocdInstallError(refusal)

	if got.Error() != refusal.Error() {
		t.Fatalf("a refusal must arrive verbatim.\n got: %s\nwant: %s", got, refusal)
	}
	if strings.Contains(got.Error(), "install failed") {
		t.Errorf("a refusal must not be dressed as an install failure: %s", got)
	}
	var still *argocd.PreflightRefusal
	if !errors.As(got, &still) {
		t.Errorf("the refusal must stay classifiable, got %T", got)
	}
}

// Everything else keeps the framing it had: a genuine install failure IS an install failure.
func TestArgocdInstallErrorWrapsEverythingElse(t *testing.T) {
	got := argocdInstallError(errors.New("helm upgrade exited 1"))

	if !strings.HasPrefix(got.Error(), "ArgoCD install failed: ") {
		t.Fatalf("a real failure keeps its framing, got: %s", got)
	}
	if !strings.Contains(got.Error(), "helm upgrade exited 1") {
		t.Errorf("the cause must survive: %s", got)
	}
}
