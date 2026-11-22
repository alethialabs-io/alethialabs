// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunProviderStatus(t *testing.T) {
	c := &fakeClient{providerStat: &api.ProviderStatus{
		Connected: true, IdentityID: "id-1", AccountID: "123456789012", RoleArn: "arn:aws:iam::123:role/x",
	}}
	p, buf, _ := cloudsTestPrinter("table")
	if err := runProviderStatus(c, p, "aws"); err != nil {
		t.Fatalf("runProviderStatus: %v", err)
	}
	out := buf.String()
	for _, want := range []string{"connected", "id-1", "123456789012"} {
		if !strings.Contains(out, want) {
			t.Errorf("status output missing %q:\n%s", want, out)
		}
	}
}

func TestRunProviderStatusDisconnected(t *testing.T) {
	c := &fakeClient{providerStat: &api.ProviderStatus{Connected: false}}
	p, buf, _ := cloudsTestPrinter("table")
	if err := runProviderStatus(c, p, "gcp"); err != nil {
		t.Fatalf("runProviderStatus: %v", err)
	}
	if !strings.Contains(buf.String(), "disconnected") {
		t.Errorf("expected disconnected, got: %q", buf.String())
	}
}

func TestRunProviderStatusError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	p, _, _ := cloudsTestPrinter("table")
	if err := runProviderStatus(c, p, "aws"); err == nil {
		t.Error("expected error to propagate")
	}
}

func TestRunProviderVerifyConnected(t *testing.T) {
	c := &fakeClient{
		providerStat: &api.ProviderStatus{Connected: true, IdentityID: "id-1"},
		verifyResult: &api.ConnectIdentityResponse{IdentityID: "id-1", Verified: true, Status: "connected"},
	}
	p, buf, _ := cloudsTestPrinter("table")
	if err := runProviderVerify(c, p, "aws"); err != nil {
		t.Fatalf("runProviderVerify: %v", err)
	}
	if !strings.Contains(buf.String(), "connected") {
		t.Errorf("expected verdict rendered, got: %q", buf.String())
	}
}

func TestRunProviderVerifyNotConnected(t *testing.T) {
	c := &fakeClient{providerStat: &api.ProviderStatus{Connected: false}}
	p, _, _ := cloudsTestPrinter("table")
	err := runProviderVerify(c, p, "azure")
	if err == nil || !strings.Contains(err.Error(), "no connected azure identity") {
		t.Errorf("expected no-connected-identity error, got: %v", err)
	}
}

func TestRunProviderVerifyFails(t *testing.T) {
	c := &fakeClient{
		providerStat: &api.ProviderStatus{Connected: true, IdentityID: "id-1"},
		verifyResult: &api.ConnectIdentityResponse{IdentityID: "id-1", Verified: false, Status: "disconnected", Error: "access denied"},
	}
	p, buf, _ := cloudsTestPrinter("table")
	err := runProviderVerify(c, p, "aws")
	if err == nil || !strings.Contains(err.Error(), "failed verification") {
		t.Errorf("expected verification failure error, got: %v", err)
	}
	// A failed probe is an error and not a result: the reason travels in the error, the exit code
	// is the operation-failed one, and stdout stays empty.
	if err != nil && !strings.Contains(err.Error(), "access denied") {
		t.Errorf("the error does not carry the control plane's reason: %v", err)
	}
	if got := clierr.From(err); got == nil || got.Exit != clierr.ExitOperationFailed {
		t.Errorf("a failed probe is classed %+v, want exit %d", got, clierr.ExitOperationFailed)
	}
	if buf.Len() != 0 {
		t.Errorf("a failed probe wrote on stdout: %q", buf.String())
	}
}

func TestRunProviderVerifyStatusError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	p, _, _ := cloudsTestPrinter("table")
	if err := runProviderVerify(c, p, "aws"); err == nil {
		t.Error("expected error when status lookup fails")
	}
}
