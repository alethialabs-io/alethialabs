// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"errors"
	"strings"
	"testing"
)

// #3348's own "suggested check", followed literally: assert on the FAILURE MESSAGE, not the exit
// status. The old behaviour already failed correctly in the sense that the job went FAILED — what
// was broken is that the message sent the reader to EC2 instance metadata on a host that was never
// EC2. So every assertion here is about what the operator reads at 3am.

// The verbatim production error from #3348, trimmed of the role ARN.
const imdsErr = "operation error STS: AssumeRole, get identity: get credentials: " +
	"failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: " +
	"GetMetadata, http response error StatusCode: 404, request to EC2 IMDS failed"

func TestAmbientCredentialFailureExplainsTheSelfPath(t *testing.T) {
	msg := ambientCredentialFailure("Failed to assume role", "aws", "self", errors.New(imdsErr))

	// The original error is never dropped — it is the only thing that identifies WHICH call failed.
	if !strings.Contains(msg, imdsErr) {
		t.Fatalf("the underlying SDK error was lost:\n%s", msg)
	}
	for _, want := range []string{
		`operator "self"`,                     // which operator the PROCESS is running as
		"AMBIENT aws",                         // which credential path that selects
		"AWS_ACCESS_KEY_ID",                   // where it actually looked
		`"managed"-only`,                      // that keyless federation is not available here
		"the record and the process disagree", // the mismatch that made #3348 hard to spot
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message does not say %q:\n%s", want, msg)
		}
	}
}

func TestAmbientCredentialFailureNamesImdsAsTheLastSourceNotTheCause(t *testing.T) {
	msg := ambientCredentialFailure("Failed to assume role", "aws", "self", errors.New(imdsErr))
	if !strings.Contains(msg, "LAST source") {
		t.Errorf("did not correct the IMDS red herring:\n%s", msg)
	}
	if !strings.Contains(msg, "never EC2") {
		t.Errorf("did not say the host was never EC2:\n%s", msg)
	}
}

// A REAL authorization failure must not be dressed up as a missing credential source. The extra
// paragraph is appended only when the SDK says it exhausted its chain.
func TestAmbientCredentialFailureLeavesARealDenialAlone(t *testing.T) {
	denied := errors.New("operation error STS: AssumeRole, https response error StatusCode: 403, " +
		"AccessDenied: User is not authorized to perform sts:AssumeRole")
	msg := ambientCredentialFailure("Failed to assume role", "aws", "self", denied)

	if !strings.Contains(msg, `operator "self"`) {
		t.Errorf("a self runner should still be told which path it took:\n%s", msg)
	}
	if strings.Contains(msg, "LAST source") {
		t.Errorf("a 403 is not an exhausted credential chain:\n%s", msg)
	}
}

// The whole point of the operator gate: a managed runner federates keylessly and never reads
// ambient credentials, so none of this explanation applies to it.
func TestAmbientCredentialFailureIsSilentForAManagedRunner(t *testing.T) {
	msg := ambientCredentialFailure("Failed to activate AWS federation", "aws", "managed", errors.New(imdsErr))
	if msg != "Failed to activate AWS federation: "+imdsErr {
		t.Errorf("a managed runner's message must be unchanged, got:\n%s", msg)
	}
}

// Azure, Alibaba and the token clouds have no operator branch — they cannot reach the ambient path
// at all — so claiming they read ambient credentials would be a confident wrong answer.
func TestAmbientCredentialFailureSaysNothingAboutProvidersWithNoOperatorBranch(t *testing.T) {
	for _, provider := range []string{"azure", "alibaba", "hetzner", "digitalocean", "civo"} {
		msg := ambientCredentialFailure("Failed", provider, "self", errors.New("boom"))
		if msg != "Failed: boom" {
			t.Errorf("%s has no operator branch; message must be unchanged, got:\n%s", provider, msg)
		}
	}
}

func TestAmbientCredentialFailureCoversTheGcpHalf(t *testing.T) {
	adc := errors.New("google: could not find default credentials")
	msg := ambientCredentialFailure("Failed to activate GCP WIF", "gcp", "self", adc)
	for _, want := range []string{"AMBIENT gcp", "Application Default Credentials", "LAST source"} {
		if !strings.Contains(msg, want) {
			t.Errorf("gcp message does not say %q:\n%s", want, msg)
		}
	}
}

func TestLooksLikeNoAmbientCredentials(t *testing.T) {
	if looksLikeNoAmbientCredentials(nil) {
		t.Error("a nil error is not a credential-chain failure")
	}
	for _, e := range []string{
		imdsErr,
		"google: could not find default credentials",
		"Your default credentials were not found",
		"no credential sources available",
	} {
		if !looksLikeNoAmbientCredentials(errors.New(e)) {
			t.Errorf("should match an exhausted chain: %q", e)
		}
	}
	if looksLikeNoAmbientCredentials(errors.New("AccessDenied: not authorized to perform sts:AssumeRole")) {
		t.Error("a 403 is not an exhausted chain")
	}
}
