// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package agent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CLAIM TIME — #3348's second ask: "a record/process mismatch should be reported at claim time,
// not inferred from an IMDS 404 much later".
//
// Every assertion below is on the MESSAGE, for the same reason the ones above are: the job already
// went FAILED before any of this existed. A test that only asserted `err != nil` would have passed
// on the IMDS 404 and proved nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// oidcWIF is a direct-OIDC workload-identity config — the shape the control plane stores for a
// KEYLESS GCP connection, whose credential_source is a placeholder only the managed path fills.
const oidcWIF = `{"type":"external_account","subject_token_type":"` + gcpJWTSubjectTokenType + `",` +
	`"audience":"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/alethia/providers/alethia",` +
	`"credential_source":{"file":"/var/run/alethia/PLACEHOLDER"}}`

// emptyEnv is a process with nothing configured: no credential variables and no HOME, so no
// well-known credential file can be found either.
func emptyEnv(string) string { return "" }

// noFiles is a filesystem in which no credential file exists.
func noFiles(string) bool { return false }

// envFrom turns a map into a getenv for preflightCloudIdentity.
func envFrom(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestPreflightRefusesAKeylessGcpConnectionOnASelfRunner(t *testing.T) {
	f, ok := preflightCloudIdentity(&CloudIdentity{Provider: "gcp", WifConfig: oidcWIF}, "self", emptyEnv, noFiles)
	if !ok || !f.Refuse {
		t.Fatalf("a keyless GCP connection handed to a self runner must be refused at claim time; got ok=%v %+v", ok, f)
	}
	for _, want := range []string{
		"claim time",                     // WHEN this was found — the whole point of the unit
		`operator "self"`,                // the operator this PROCESS is actually running as
		"what the CONTROL PLANE expects", // and what the record it was handed implies
		`"managed"-only`,                 // keyless federation is managed-only
		"direct-OIDC",                    // the evidence, so the reader can check it
		"credential_source",
		"check Runners in the console",
	} {
		if !strings.Contains(f.Message, want) {
			t.Errorf("the claim-time refusal does not say %q:\n%s", want, f.Message)
		}
	}
	// The failure it REPLACES is the one that sends the reader to ADC. It must not reproduce it
	// as the headline.
	if strings.HasPrefix(f.Message, "Failed to activate GCP WIF") {
		t.Errorf("the refusal leads with the SDK's message again:\n%s", f.Message)
	}
}

// The refusal is keyed on the DIRECT-OIDC marker, not on "the provider is gcp". A legacy AWS-hub
// config is a different (already-reported) problem, and a self runner with real ambient GCP
// credentials can genuinely use one.
func TestPreflightDoesNotRefuseANonKeylessGcpConnection(t *testing.T) {
	legacy := `{"subject_token_type":"urn:ietf:params:aws:token-type:aws4_request"}`
	env := envFrom(map[string]string{"GOOGLE_APPLICATION_CREDENTIALS": "/etc/gcp/sa.json"})

	f, ok := preflightCloudIdentity(&CloudIdentity{Provider: "gcp", WifConfig: legacy}, "self", env, noFiles)
	if ok {
		t.Fatalf("an ambient GCP identity with a non-keyless config is this runner's job; got %+v", f)
	}
}

// The gate is `!= "managed"`, which is what runner.go branches on — so an UNSET operator, which
// also takes the ambient path, must be caught too. Reading the gate as `== "self"` is how an
// operator nobody set got the bare SDK error.
func TestPreflightCatchesAnUnsetOperatorBecauseItAlsoTakesTheAmbientPath(t *testing.T) {
	f, ok := preflightCloudIdentity(&CloudIdentity{Provider: "gcp", WifConfig: oidcWIF}, "", emptyEnv, noFiles)
	if !ok || !f.Refuse {
		t.Fatalf("an unset operator takes the ambient path and must be refused too; got ok=%v %+v", ok, f)
	}
	if !strings.Contains(f.Message, "unset") {
		t.Errorf("an empty operator must read as UNSET, not as a missing value:\n%s", f.Message)
	}
}

// A managed runner federates keylessly. Nothing here applies to it, and saying otherwise would be
// a confident wrong answer on the one configuration that works.
func TestPreflightIsSilentForAManagedRunner(t *testing.T) {
	for _, ci := range []*CloudIdentity{
		{Provider: "gcp", WifConfig: oidcWIF},
		{Provider: "aws", RoleArn: "arn:aws:iam::1:role/r"},
	} {
		if f, ok := preflightCloudIdentity(ci, "managed", emptyEnv, noFiles); ok {
			t.Errorf("%s: a managed runner needs no ambient credentials; got %+v", ci.Provider, f)
		}
	}
}

// #3348's asymmetry, preserved: azure and alibaba have NO operator branch and the token clouds
// carry their own credential, so none of them can reach the ambient path. Warning about them would
// send the reader after a cause that does not exist.
func TestPreflightIsSilentForProvidersWithNoOperatorBranch(t *testing.T) {
	for _, p := range []string{"azure", "alibaba", "hetzner", "digitalocean", "civo"} {
		if f, ok := preflightCloudIdentity(&CloudIdentity{Provider: p}, "self", emptyEnv, noFiles); ok {
			t.Errorf("%s has no operator branch; claim-time check must say nothing, got %+v", p, f)
		}
	}
}

func TestPreflightIgnoresAJobWithNoCloudIdentity(t *testing.T) {
	if f, ok := preflightCloudIdentity(nil, "self", emptyEnv, noFiles); ok {
		t.Errorf("a job with no cloud identity uses no credential path; got %+v", f)
	}
}

// The AWS half. It cannot be PROVEN at claim time — an instance role leaves no trace in the
// environment — so it is a notice, not a refusal. It must still answer the three questions the
// IMDS 404 does not.
func TestPreflightNoticesAnAwsRunnerWithNoCredentialSourceAtAll(t *testing.T) {
	f, ok := preflightCloudIdentity(&CloudIdentity{Provider: "aws", RoleArn: "arn:aws:iam::1:role/r"}, "self", emptyEnv, noFiles)
	if !ok {
		t.Fatal("a self runner with no AWS credential source must be told so at claim time")
	}
	if f.Refuse {
		t.Fatalf("this cannot be proven here — a host may still serve an instance role — so it must not "+
			"refuse a job that would have worked:\n%s", f.Message)
	}
	for _, want := range []string{
		"Claim-time check",
		`operator "self"`,
		"NO aws credential source",
		"EC2 IMDS", // named only to say it is NOT the cause
		"LAST source",
		`"managed"-only`,
		"check Runners in the console",
	} {
		if !strings.Contains(f.Message, want) {
			t.Errorf("the claim-time notice does not say %q:\n%s", want, f.Message)
		}
	}
}

// A configured source means this runner is doing exactly what a self-hosted runner is for. The
// notice would be noise, and noise is how a real one stops being read.
func TestPreflightIsSilentWhenAnAmbientSourceIsConfigured(t *testing.T) {
	cases := map[string]func(string) string{
		"static keys": envFrom(map[string]string{"AWS_ACCESS_KEY_ID": "AKIA…"}),
		"a profile":   envFrom(map[string]string{"AWS_PROFILE": "prod"}),
		"ECS task role": envFrom(map[string]string{
			"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/v2/credentials/abc",
		}),
		"EKS web identity": envFrom(map[string]string{"AWS_WEB_IDENTITY_TOKEN_FILE": "/var/run/token"}),
	}
	for name, env := range cases {
		if f, ok := preflightCloudIdentity(&CloudIdentity{Provider: "aws"}, "self", env, noFiles); ok {
			t.Errorf("%s: a configured source is not a missing one; got %+v", name, f)
		}
	}
}

// ~/.aws/credentials leaves NO environment variable behind. Ignoring the well-known files would
// make an ordinary `aws configure` look like an empty environment and warn on every job.
func TestPreflightIsSilentForAWellKnownCredentialFile(t *testing.T) {
	env := envFrom(map[string]string{"HOME": "/home/runner"})
	exists := func(p string) bool { return p == "/home/runner/.aws/credentials" }

	if f, ok := preflightCloudIdentity(&CloudIdentity{Provider: "aws"}, "self", env, exists); ok {
		t.Errorf("a shared credentials file IS a credential source; got %+v", f)
	}
}

func TestAmbientCredentialSources(t *testing.T) {
	env := envFrom(map[string]string{"HOME": "/h", "AWS_PROFILE": "p", "AWS_REGION": "eu-central-1"})
	exists := func(p string) bool { return p == "/h/.aws/config" }

	got := strings.Join(ambientCredentialSources("aws", env, exists), ",")
	if got != "AWS_PROFILE,~/.aws/config" {
		t.Errorf("sources should be the configured ones, sorted; got %q", got)
	}
	// AWS_REGION is not a credential source, and must not be counted as one.
	if strings.Contains(got, "AWS_REGION") {
		t.Errorf("AWS_REGION is not a credential source: %q", got)
	}
	if len(ambientCredentialSources("gcp", emptyEnv, noFiles)) != 0 {
		t.Error("an empty environment has no GCP credential source")
	}
	if len(ambientCredentialSources("gcp", envFrom(map[string]string{"GOOGLE_CREDENTIALS": "{}"}), noFiles)) != 1 {
		t.Error("GOOGLE_CREDENTIALS is an ADC source")
	}
	// A provider with no ambient path has no sources to enumerate, HOME or not.
	if len(ambientCredentialSources("azure", envFrom(map[string]string{"HOME": "/h"}), func(string) bool { return true })) != 0 {
		t.Error("azure has no operator branch and therefore no ambient source list")
	}
}

// runner.go's credential switch is an EXACT match over types.CloudProvider's lowercase values and
// has no default clause, so a provider string that is not one of them activates no credential path
// at all. Warning that such a job "will read AMBIENT credentials" would be a confident wrong answer
// about a job that reads none, so the comparison here is exact too — this check must be
// co-extensive with the branch it explains, never wider.
func TestPreflightMatchesTheProviderExactlyLikeTheCredentialSwitch(t *testing.T) {
	if _, ok := preflightCloudIdentity(&CloudIdentity{Provider: "aws"}, "self", emptyEnv, noFiles); !ok {
		t.Fatal("the canonical provider value must be checked")
	}
	for _, p := range []string{"AWS", " aws ", "Aws", "gcp ", ""} {
		if f, ok := preflightCloudIdentity(&CloudIdentity{Provider: p}, "self", emptyEnv, noFiles); ok {
			t.Errorf("%q activates no credential path in runner.go, so nothing here applies to it; got %+v", p, f)
		}
	}
}

func TestOperatorLabelMakesAnUnsetOperatorLegible(t *testing.T) {
	if got := operatorLabel("self"); got != `"self"` {
		t.Errorf("a set operator is quoted plainly; got %s", got)
	}
	got := operatorLabel("")
	if !strings.Contains(got, "unset") || !strings.Contains(got, "managed") {
		t.Errorf(`an empty operator must read as unset AND say what actually selects the path; got %s`, got)
	}
}

// The failure-time message shares the gate. It used to return early unless the operator was
// literally "self", so an unset one — which takes the same ambient path — got the bare SDK error.
func TestAmbientCredentialFailureExplainsAnUnsetOperatorToo(t *testing.T) {
	msg := ambientCredentialFailure("Failed to assume role", "aws", "", errors.New(imdsErr))
	for _, want := range []string{"unset", "AMBIENT aws", "LAST source", `"managed"-only`} {
		if !strings.Contains(msg, want) {
			t.Errorf("an unset operator takes the ambient path and must be explained; missing %q:\n%s", want, msg)
		}
	}
}

func TestTakesAmbientPathMirrorsTheRunnerBranch(t *testing.T) {
	if takesAmbientPath(managedOperator) {
		t.Error(`"managed" federates keylessly`)
	}
	for _, op := range []string{ambientOperator, "", "Managed", "self-hosted", "whatever"} {
		if !takesAmbientPath(op) {
			t.Errorf("runner.go branches on == %q, so %q takes the ambient path", managedOperator, op)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// End to end through executeJob — because "at claim time" is a claim about WHEN, and only the
// real dispatch path can settle it. Each of these asserts on the text the user reads AND on the
// absence of the credential-activation banner, which is what proves nothing doomed was attempted.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// clearAmbientCredentials gives the test process the environment #3348's container actually has:
// no cloud credentials of any kind, and a HOME with no well-known credential files in it.
func clearAmbientCredentials(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	for _, k := range append(append([]string{}, ambientEnvSources["aws"]...), ambientEnvSources["gcp"]...) {
		t.Setenv(k, "")
	}
}

// jobLog is everything the job's streams carried, in order.
func jobLog(api *covRunAPI) string {
	var b strings.Builder
	for _, c := range api.getLogChunks() {
		b.WriteString(c.chunk)
		b.WriteString("\n")
	}
	return b.String()
}

// The production shape of #3348's GCP half: a keyless connection routed to the deployed `self`
// runner. The job must fail at claim time with the operator named — and ActivateGcpWIF must never
// be reached, because the message it would produce is the one about ADC.
func TestExecuteJob_RefusesAKeylessGcpIdentityAtClaimTime(t *testing.T) {
	clearAmbientCredentials(t)
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-gcp-self"}, api)

	err := w.executeJob(t.Context(), &ClaimResponse{
		Job:           &Job{ID: "pf-gcp-self", JobType: string(types.JobTypePlan), ConfigSnapshot: covRunSnapshot()},
		CloudIdentity: &CloudIdentity{Provider: "gcp", ProjectID: "p", WifConfig: oidcWIF},
	})
	if err == nil {
		t.Fatal("a self runner cannot use a keyless GCP identity; the job must fail")
	}

	u, ok := covRunTerminal(api, "pf-gcp-self")
	if !ok || u.status != "FAILED" {
		t.Fatalf("expected FAILED, got %+v", u)
	}
	// The exit status was ALREADY correct before this unit existed. The message is the fix.
	for _, want := range []string{
		"claim time",
		`operator "self"`,
		`"managed"-only`,
		"direct-OIDC",
		"check Runners in the console",
	} {
		if !strings.Contains(u.errMsg, want) {
			t.Errorf("the job's recorded failure does not say %q:\n%s", want, u.errMsg)
		}
	}
	if !strings.Contains(jobLog(api), "claim time") {
		t.Errorf("the refusal must reach the job's log stream, not only the status row:\n%s", jobLog(api))
	}
	// "At claim time" means BEFORE the credential call. If this banner appeared, the check ran
	// too late and the reader would still be looking at an ADC error.
	if strings.Contains(jobLog(api), "Activating WIF for project") {
		t.Errorf("the credential path was entered anyway — this is no longer a claim-time check:\n%s", jobLog(api))
	}
}

// The AWS half cannot be proven here, so the job proceeds to the real credential call — but the
// reader is told at claim time what is about to happen and why the IMDS line will not be the cause.
func TestExecuteJob_WarnsAtClaimTimeWhenAnAwsSelfRunnerHasNoCredentialSource(t *testing.T) {
	clearAmbientCredentials(t)
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_REGION", "eu-central-1")

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the STS call fails locally — no network, no ambient credentials

	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "self", RunnerID: "r-aws-self-pf"}, api)

	_ = w.executeJob(ctx, &ClaimResponse{
		Job:           &Job{ID: "pf-aws-self", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
		CloudIdentity: &CloudIdentity{Provider: "aws", RoleArn: "arn:aws:iam::1:role/r", AccountID: "1"},
	})

	log := jobLog(api)
	for _, want := range []string{
		"Claim-time check",
		`operator "self"`,
		"NO aws credential source",
		"LAST source",
		`"managed"-only`,
	} {
		if !strings.Contains(log, want) {
			t.Errorf("the claim-time notice does not say %q:\n%s", want, log)
		}
	}
	// It is a notice, not a refusal: the job still reaches the credential call, which is the only
	// thing that can actually rule out an instance role.
	if !strings.Contains(log, "Assuming role") {
		t.Errorf("a notice must not stop the job — the credential call is still the verdict:\n%s", log)
	}
}

// The one configuration that works must be untouched: a managed runner federates keylessly and
// must see no claim-time noise at all.
func TestExecuteJob_SaysNothingAtClaimTimeForAManagedRunner(t *testing.T) {
	clearAmbientCredentials(t)
	api := newCovRunAPI()
	w := NewWithAPI(Config{Operator: "managed", RunnerID: "r-managed-pf"}, api)

	_ = w.executeJob(t.Context(), &ClaimResponse{
		Job:           &Job{ID: "pf-managed", JobType: "COVRUN_BOGUS", ConfigSnapshot: map[string]any{}},
		CloudIdentity: &CloudIdentity{Provider: "aws", RoleArn: "arn:aws:iam::1:role/r", AccountID: "1"},
	})

	log := jobLog(api)
	if strings.Contains(log, "Claim-time check") || strings.Contains(log, "Refusing this job at claim time") {
		t.Errorf("a managed runner needs no ambient credentials and must not be warned:\n%s", log)
	}
	if !strings.Contains(log, "keyless AWS federation") {
		t.Errorf("the managed path must still run:\n%s", log)
	}
}
