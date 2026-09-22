// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
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

// ambientOperator is the canonical operator value that takes the ambient-credential path. Its
// counterpart, "managed", federates keylessly and needs no ambient identity.
const ambientOperator = "self"

// managedOperator is the ONLY operator value that federates keylessly, and saying so as a constant
// matters because it is the actual predicate: `runner.go` branches on `Operator == "managed"`, so
// EVERY other value — "self", "", a typo, a future value — falls through to the ambient path.
// Reading the gate as "self takes the ambient path" is how an unset ALETHIA_RUNNER_OPERATOR used to
// get the ambient failure with none of the explanation attached to it (#3348).
const managedOperator = "managed"

// takesAmbientPath mirrors runner.go's credential branch exactly: anything that is not "managed"
// reads ambient credentials. Kept beside the constants so the two cannot drift apart silently.
func takesAmbientPath(operator string) bool { return operator != managedOperator }

// operatorLabel renders an operator for a human. An empty operator is the interesting case — it is
// not "no operator", it is "the ambient path, chosen by default" — and printing `operator ""` would
// read as a missing value rather than as the thing that selected the failing path.
func operatorLabel(operator string) string {
	if operator == "" {
		return `"" (unset — anything other than "managed" takes the ambient path)`
	}
	return fmt.Sprintf("%q", operator)
}

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

	if !takesAmbientPath(operator) {
		return b.String()
	}

	source, known := providerCredentialSource[provider]
	if !known {
		return b.String()
	}

	fmt.Fprintf(&b, "\n\nThis runner is running as operator %s, which uses AMBIENT %s credentials from its own "+
		"environment — it does not federate. It read %s and found no usable identity.",
		operatorLabel(operator), provider, source)

	if looksLikeNoAmbientCredentials(err) {
		fmt.Fprint(&b, "\n\nThe error above is the SDK reporting the LAST source it tried, not the cause: no "+
			"credential source was configured at all. In particular an \"EC2 IMDS\" 404 is not an instance-metadata "+
			"problem — it is what the AWS chain says on a host that was never EC2.")
	}

	fmt.Fprintf(&b, "\n\nKeyless federation into the customer role is %q-only, selected by "+
		"ALETHIA_RUNNER_OPERATOR (or ALETHIA_RUNNER_MODE). If the control plane lists this runner as %q, "+
		"the record and the process disagree — the process is what decides, and it is %s.",
		managedOperator, managedOperator, operatorLabel(operator))

	return b.String()
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CLAIM TIME — #3348's second ask
//
// The message above is read AFTER a doomed credential refresh. #3348 asks for the record/process
// disagreement to be "reported at claim time, not inferred from an IMDS 404 much later", so what
// follows runs the moment a job carrying a cloud identity is claimed, before any credential call.
//
// WHAT THE RUNNER CAN AND CANNOT KNOW HERE, because the difference decides what may FAIL a job.
//
// It cannot read the control plane's `runners.operator` column: the claim response carries `job`,
// `cloud_identity` and `connector_credentials` and nothing about the runner record. So "the
// operator the control plane recorded" is never asserted from a field that does not exist.
//
// What it CAN read is the CLOUD IDENTITY the control plane just handed over, and for GCP that
// identity states which federation path it was built for. A direct-OIDC WIF config
// (subject_token_type = …:jwt) exchanges a SUBJECT TOKEN that only the Alethia issuer can mint,
// and only ActivateGcpOIDC — the managed path — mints one. The stored config's
// `credential_source.file` is a placeholder for exactly that reason; a non-managed process runs
// ActivateGcpWIF on the config verbatim, so google-auth is pointed at a token nobody produced.
// Nothing a self-hosted runner has in its environment can satisfy that config, whatever the
// credential source's shape, which is why the predicate is the subject-token type and not the
// placeholder path. That is a PROVEN mismatch between what the control plane set this connection
// up for and what this process is, readable from the payload alone, so it refuses.
//
// AWS has no such marker on the wire — the claim carries a role ARN and nothing that distinguishes
// a role trusting the Alethia issuer from one trusting an ambient principal — and the ambient
// chain's last source (an instance role) leaves no trace in the environment to test for. Refusing
// AWS on "no credential env vars" would therefore reject a self-hosted runner on EC2 that would
// have worked. So AWS gets a claim-time NOTICE, not a refusal: it predicts the failure, names the
// operator, and says what to check — and the job still reaches the real credential call, which is
// where the verdict belongs. A guard whose false positive is a refused working job is worse than
// no guard.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// ambientEnvSources lists, per operator-gated provider, the environment variables whose presence
// means SOME ambient credential source is configured. Presence is all that is checked — a wrong
// key is an authorization failure, which is a different (and already legible) error.
var ambientEnvSources = map[string][]string{
	"aws": {
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_PROFILE",
		"AWS_DEFAULT_PROFILE",
		"AWS_SHARED_CREDENTIALS_FILE",
		"AWS_CONFIG_FILE",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_ROLE_ARN",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	},
	"gcp": {
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CREDENTIALS",
		"CLOUDSDK_AUTH_ACCESS_TOKEN",
	},
}

// ambientFileSources lists the well-known credential files each provider's chain reads, relative
// to $HOME. They are the sources that leave no environment variable behind, so omitting them would
// make a developer's ordinary `aws configure` look like an empty environment.
var ambientFileSources = map[string][]string{
	"aws": {".aws/credentials", ".aws/config"},
	"gcp": {".config/gcloud/application_default_credentials.json"},
}

// ambientCredentialSources returns the names of the ambient credential sources this process
// actually has configured for a provider, sorted, or an empty slice when it has none.
//
// getenv and fileExists are injected so the answer is a pure function of an environment a test can
// state outright. It deliberately does NOT probe a metadata server: that is a network call whose
// answer on a non-EC2 host is the very 404 this whole file exists to stop quoting, and several
// clouds answer at 169.254.169.254 without serving an IAM role — so reachability would be a
// confident wrong answer. The metadata source's absence from this list is why an empty result is a
// NOTICE and not a refusal.
func ambientCredentialSources(provider string, getenv func(string) string, fileExists func(string) bool) []string {
	var found []string
	for _, key := range ambientEnvSources[provider] {
		if getenv(key) != "" {
			found = append(found, key)
		}
	}
	if home := getenv("HOME"); home != "" {
		for _, rel := range ambientFileSources[provider] {
			if fileExists(filepath.Join(home, rel)) {
				found = append(found, "~/"+rel)
			}
		}
	}
	sort.Strings(found)
	return found
}

// claimFinding is the claim-time verdict on one cloud identity. Refuse=true means the job cannot
// possibly succeed and must be failed here, with Message as its failure text; Refuse=false means
// Message is a warning to put in front of the reader while the job proceeds.
type claimFinding struct {
	Refuse  bool
	Message string
}

// preflightCloudIdentity is the claim-time check. It returns (finding, true) when there is
// something to say, and ok=false when the claim is none of its business.
//
// Silent by construction for: a managed runner (it federates, so ambient credentials are
// irrelevant); azure and alibaba, which have NO operator branch and are always keyless; and the
// token clouds, which carry their own credential. That asymmetry is #3348's own table and is the
// reason this keys off providerCredentialSource rather than off the provider list.
func preflightCloudIdentity(ci *CloudIdentity, operator string, getenv func(string) string, fileExists func(string) bool) (claimFinding, bool) {
	if ci == nil || !takesAmbientPath(operator) {
		return claimFinding{}, false
	}
	provider := strings.ToLower(strings.TrimSpace(ci.Provider))
	if _, gated := providerCredentialSource[provider]; !gated {
		return claimFinding{}, false
	}

	if provider == "gcp" && isOidcWifJSON(ci.WifConfig) {
		return claimFinding{Refuse: true, Message: keylessRecordRefusal(provider, operator)}, true
	}

	if sources := ambientCredentialSources(provider, getenv, fileExists); len(sources) == 0 {
		return claimFinding{Message: noAmbientSourceNotice(provider, operator)}, true
	}
	return claimFinding{}, false
}

// cloudIdentityPreflight is preflightCloudIdentity against the real process environment.
func cloudIdentityPreflight(ci *CloudIdentity, operator string) (claimFinding, bool) {
	return preflightCloudIdentity(ci, operator, os.Getenv, func(path string) bool {
		_, err := os.Stat(path)
		return err == nil
	})
}

// recordMismatchAdvice is the sentence both claim-time messages end on. The runner cannot read the
// control plane's record — so this says where to look and what #3348 saw there, instead of
// asserting a value nothing sent.
const recordMismatchAdvice = "The claim response carries no runner-operator field, so this process cannot read what the " +
	"control plane has RECORDED for it — check Runners in the console. In #3348 it listed this runner as " +
	"\"" + managedOperator + "\" while the process ran as \"" + ambientOperator + "\": the record and the process " +
	"disagreed, and nothing reported it. The process is what chooses the credential path."

// keylessRecordRefusal is the failure text for a job whose cloud identity was built for keyless
// federation and was handed to a runner that cannot federate.
func keylessRecordRefusal(provider, operator string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Refusing this job at claim time: the %s connection the control plane just handed over is set up "+
		"for KEYLESS federation, and this runner is running as operator %s, which cannot use it.",
		provider, operatorLabel(operator))

	fmt.Fprintf(&b, "\n\n  operator this PROCESS runs as   %s — from ALETHIA_RUNNER_OPERATOR (or ALETHIA_RUNNER_MODE)"+
		"\n  what the CONTROL PLANE expects  %q — it sent a direct-OIDC workload-identity config"+
		"\n  keyless federation              %q-only",
		operatorLabel(operator), managedOperator, managedOperator)

	fmt.Fprint(&b, "\n\nA direct-OIDC workload-identity config is exchanged for a Google token using a SUBJECT "+
		"ASSERTION that only the Alethia issuer mints, and only the managed path asks it for one — the stored "+
		"config's credential_source is a placeholder for exactly that reason. A non-managed runner writes the "+
		"config verbatim and points the Google SDK at a token nobody produced, which the SDK reports as missing "+
		"Application Default Credentials — a message about ADC, not about the operator. Reporting it here is the "+
		"point: the cause is known at claim time.")

	fmt.Fprint(&b, "\n\n"+recordMismatchAdvice)

	fmt.Fprintf(&b, "\n\nFix: run this runner as operator %q, or route this job to a runner that already is. "+
		"(azure and alibaba have no operator branch and are always keyless, and the token clouds carry their own "+
		"credential, so only aws and gcp can reach this.)", managedOperator)

	return b.String()
}

// noAmbientSourceNotice is the claim-time warning for the case that cannot be PROVEN here: the
// ambient path with nothing configured in the environment, which still succeeds if the host serves
// an instance role. It predicts the failure rather than causing one.
func noAmbientSourceNotice(provider, operator string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Claim-time check: this runner is running as operator %s, so it will read AMBIENT %s credentials "+
		"— and it has NO %s credential source configured in its environment.",
		operatorLabel(operator), provider, provider)

	fmt.Fprintf(&b, "\n\nIt will look at %s. Unless this host serves an instance/metadata role, this job is going to "+
		"fail at the credential step — and the SDK will name its LAST source (for AWS, an \"EC2 IMDS\" 404) rather "+
		"than the cause. That last source is not the problem; having no source at all is.",
		providerCredentialSource[provider])

	fmt.Fprintf(&b, "\n\nKeyless federation into the customer role is %q-only. %s", managedOperator, recordMismatchAdvice)

	return b.String()
}
