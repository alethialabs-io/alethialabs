// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"strings"
)

// WHY THIS FILE EXISTS — the error was worse than the bug (#3348).
//
// A production job against a healthy, connected AWS account failed with:
//
//	Failed to assume role: ... no EC2 IMDS role found, operation error ec2imds: GetMetadata,
//	http response error StatusCode: 404, request to EC2 IMDS failed
//
// Nothing in that names the operator, the federation path, or a missing credential source. It
// names EC2 instance metadata — a service that has nothing to do with the cause — so the next
// move is to investigate IMDS on a host that was never going to have any. The actual cause is
// that the deployed runner runs as operator `self`, which takes the AMBIENT-credential path, and
// the container has no ambient credentials for that provider.
//
// The IMDS 404 is the AWS SDK's LAST credential source, reported as if it were the only one. GCP's
// ADC failures read the same way. So this turns the provider SDK's last-resort message into a
// statement of what actually happened, without changing which path runs — that decision is the
// other half of #3348 and is a deliberate security call, not a flag flip.

// ambientOperator is the operator value that takes the ambient-credential path. Its counterpart,
// "managed", federates keylessly and needs no ambient identity.
const ambientOperator = "self"

// providerCredentialSource names, per provider, what the ambient path actually reads — so the
// message can say where to look rather than leaving the reader with an SDK's last attempt.
//
// Only the two providers whose path is gated on the operator appear here. Azure and Alibaba have
// no operator branch (they are always keyless), and the token clouds carry their own credential,
// so neither class can reach this failure. That asymmetry is real and #3348 flags it as worth
// revisiting; this map deliberately does not paper over it by listing providers that cannot get
// here.
var providerCredentialSource = map[string]string{
	"aws": "the standard AWS chain (AWS_ACCESS_KEY_ID / AWS_PROFILE / an instance role)",
	"gcp": "Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC / a metadata server)",
}

// looksLikeNoAmbientCredentials reports whether a provider SDK error is the "no credential source
// was configured at all" shape, rather than a real authorization failure.
//
// Matching on the SDK's own words is unavoidable — neither SDK exposes a typed sentinel for
// "exhausted the chain" — so this is deliberately BROAD and its only effect is to add a sentence.
// A false positive appends an explanation to a genuine permission error; a false negative leaves
// the original message exactly as it was. Both are strictly better than the status quo, which is
// the IMDS text alone.
func looksLikeNoAmbientCredentials(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, needle := range []string{
		"ec2 imds",
		"ec2imds",
		"no ec2 imds role found",
		"failed to refresh cached credentials",
		"could not find default credentials",
		"default credentials were not found",
		"no credential sources",
	} {
		if strings.Contains(msg, needle) {
			return true
		}
	}
	return false
}

// ambientCredentialFailure builds the message a `self` runner should fail with when the ambient
// credential path could not produce an identity.
//
// It answers the three questions the IMDS 404 does not: which operator this PROCESS is running as,
// what that operator's path actually reads, and that keyless federation is `managed`-only. It also
// says explicitly that the control plane's record may disagree — #3348's runner listed as `managed`
// while the process ran as `self`, which is what made it hard to spot. The runner cannot check that
// itself: the claim response carries no operator field, so the mismatch is named as something to go
// and look at rather than asserted.
func ambientCredentialFailure(action, provider, operator string, err error) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %v", action, err)

	if operator != ambientOperator {
		return b.String()
	}

	source, known := providerCredentialSource[provider]
	if !known {
		return b.String()
	}

	fmt.Fprintf(&b, "\n\nThis runner is running as operator %q, which uses AMBIENT %s credentials from its own "+
		"environment — it does not federate. It read %s and found no usable identity.",
		operator, provider, source)

	if looksLikeNoAmbientCredentials(err) {
		fmt.Fprint(&b, "\n\nThe error above is the SDK reporting the LAST source it tried, not the cause: no "+
			"credential source was configured at all. In particular an \"EC2 IMDS\" 404 is not an instance-metadata "+
			"problem — it is what the AWS chain says on a host that was never EC2.")
	}

	fmt.Fprintf(&b, "\n\nKeyless federation into the customer role is %q-only, selected by "+
		"ALETHIA_RUNNER_OPERATOR (or ALETHIA_RUNNER_MODE). If the control plane lists this runner as %q, "+
		"the record and the process disagree — the process is what decides, and it is %q.",
		"managed", "managed", operator)

	return b.String()
}
