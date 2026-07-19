// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

func TestRunProviderStatus(t *testing.T) {
	c := &fakeClient{providerStat: &api.ProviderStatus{
		Connected: true, IdentityID: "id-1", AccountID: "123456789012", RoleArn: "arn:aws:iam::123:role/x",
	}}
	var buf bytes.Buffer
	if err := runProviderStatus(c, &buf, "table", "aws"); err != nil {
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
	var buf bytes.Buffer
	if err := runProviderStatus(c, &buf, "table", "gcp"); err != nil {
		t.Fatalf("runProviderStatus: %v", err)
	}
	if !strings.Contains(buf.String(), "disconnected") {
		t.Errorf("expected disconnected, got: %q", buf.String())
	}
}

func TestRunProviderStatusError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runProviderStatus(c, &bytes.Buffer{}, "table", "aws"); err == nil {
		t.Error("expected error to propagate")
	}
}

func TestRunProviderVerifyConnected(t *testing.T) {
	c := &fakeClient{
		providerStat: &api.ProviderStatus{Connected: true, IdentityID: "id-1"},
		verifyResult: &api.ConnectIdentityResponse{IdentityID: "id-1", Verified: true, Status: "connected"},
	}
	var buf bytes.Buffer
	if err := runProviderVerify(c, &buf, "table", "aws"); err != nil {
		t.Fatalf("runProviderVerify: %v", err)
	}
	if !strings.Contains(buf.String(), "connected") {
		t.Errorf("expected verdict rendered, got: %q", buf.String())
	}
}

func TestRunProviderVerifyNotConnected(t *testing.T) {
	c := &fakeClient{providerStat: &api.ProviderStatus{Connected: false}}
	err := runProviderVerify(c, &bytes.Buffer{}, "table", "azure")
	if err == nil || !strings.Contains(err.Error(), "no connected azure identity") {
		t.Errorf("expected no-connected-identity error, got: %v", err)
	}
}

func TestRunProviderVerifyFails(t *testing.T) {
	c := &fakeClient{
		providerStat: &api.ProviderStatus{Connected: true, IdentityID: "id-1"},
		verifyResult: &api.ConnectIdentityResponse{IdentityID: "id-1", Verified: false, Status: "disconnected", Error: "access denied"},
	}
	var buf bytes.Buffer
	err := runProviderVerify(c, &buf, "table", "aws")
	if err == nil || !strings.Contains(err.Error(), "failed verification") {
		t.Errorf("expected verification failure error, got: %v", err)
	}
	// The verdict (including the error detail) is still rendered before returning.
	if !strings.Contains(buf.String(), "access denied") {
		t.Errorf("expected error detail in verdict, got: %q", buf.String())
	}
}

func TestRunProviderVerifyStatusError(t *testing.T) {
	c := &fakeClient{err: errors.New("boom")}
	if err := runProviderVerify(c, &bytes.Buffer{}, "table", "aws"); err == nil {
		t.Error("expected error when status lookup fails")
	}
}
