// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/packages/core/verify"
	"github.com/spf13/cobra"
)

// The verify group's half of the "which job" contract. The resolver itself is the jobs group's
// and is tested there; what is tested HERE is the part verify owns — the scope that keeps
// `--latest` on a job that can carry a receipt, the `--job` alias, and the two renderings that
// used to speak for themselves (the signature glyph and the receipt's timestamps).

// verifyJobsSample is a page of jobs, newest first, whose newest entry carries NO receipt. That
// ordering is the whole point: unscoped, `--latest` lands on the drift job.
func verifyJobsSample() []api.ProvisionJob {
	base := time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC)
	return []api.ProvisionJob{
		{ID: "job-drift", JobType: string(types.JobTypeDetectDrift), Status: "SUCCESS",
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base},
		{ID: "job-probe", JobType: string(types.JobTypeProbeCluster), Status: "SUCCESS",
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-30 * time.Minute)},
		{ID: "job-deploy", JobType: string(types.JobTypeDeploy), Status: "SUCCESS",
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-time.Hour)},
		{ID: "job-plan", JobType: string(types.JobTypePlan), Status: "SUCCESS",
			ProjectID: "p-web-0001", ProjectName: "web", CreatedAt: base.Add(-2 * time.Hour)},
	}
}

// verifyFlagCmd is a bare command carrying only the persistent --job flag, so resolveVerifyJob can
// be driven without executing the real tree.
func verifyFlagCmd(t *testing.T, job string) *cobra.Command {
	t.Helper()
	c := &cobra.Command{}
	c.Flags().StringP("job", "j", "", "")
	if job != "" {
		if err := c.Flags().Set("job", job); err != nil {
			t.Fatal(err)
		}
	}
	return c
}

// --- the scope ------------------------------------------------------------------------------

// TestReceiptBearingJobScope_IsASubsetOfTheEnum pins the scope against the generated vocabulary in
// both directions: every type it names must exist, and it must leave some out. A scope that had
// grown to the whole enum would narrow nothing and every test below would pass by accident.
func TestReceiptBearingJobScope_IsASubsetOfTheEnum(t *testing.T) {
	if len(receiptBearingJobScope.Values) == 0 {
		t.Fatal("the receipt-bearing scope is empty — verify would resolve to no job at all")
	}
	for _, v := range receiptBearingJobScope.Values {
		if !containsFold(jobTypeValues(), v) {
			t.Errorf("%q is not a provision_job_type", v)
		}
	}
	if len(receiptBearingJobScope.Values) >= len(jobTypeValues()) {
		t.Errorf("the scope names %d of %d job types — it excludes nothing",
			len(receiptBearingJobScope.Values), len(jobTypeValues()))
	}
	// Named, not counted. A floor of "at least two" passes with DESTROY and AUDIT in the set.
	for _, want := range []types.JobType{types.JobTypePlan, types.JobTypeDeploy} {
		if !containsFold(receiptBearingJobScope.Values, string(want)) {
			t.Errorf("%s attaches verify_receipt in the runner and is not in the scope", want)
		}
	}
	// DETECT_DRIFT is the one the operator actually trips over: it runs on a schedule, so in a
	// real org it is very often the newest job.
	if containsFold(receiptBearingJobScope.Values, string(types.JobTypeDetectDrift)) {
		t.Error("DETECT_DRIFT carries no receipt and must not be in the scope")
	}
	if receiptBearingJobScope.Field == nil || receiptBearingJobScope.Field.Flag != "type" {
		t.Errorf("the scope must constrain the --type field, got %+v", receiptBearingJobScope.Field)
	}
}

// TestVerifySelector_LatestSkipsJobsWithNoReceipt is the defect itself. Both halves are asserted,
// so a scope that stopped applying could not pass by resolving "a job".
func TestVerifySelector_LatestSkipsJobsWithNoReceipt(t *testing.T) {
	jobsSelectNoInput(t)

	unscoped := &jobsSelectLister{jobs: verifyJobsSample()}
	ref, err := resolveJob(unscoped, nil, jobSelector{latest: true})
	if err != nil {
		t.Fatalf("unscoped resolveJob: %v", err)
	}
	if ref.ID != "job-drift" {
		t.Fatalf("unscoped --latest resolved %q, want job-drift — the fixture no longer poses the problem", ref.ID)
	}

	scoped := &jobsSelectLister{jobs: verifyJobsSample()}
	ref, err = resolveVerifyJob(scoped, verifyFlagCmd(t, ""), nil, jobSelector{latest: true})
	if err != nil {
		t.Fatalf("verify-scoped resolveVerifyJob: %v", err)
	}
	if ref.ID != "job-deploy" {
		t.Errorf("verify --latest resolved %q, want job-deploy — the newest job that carries a receipt", ref.ID)
	}
	if ref.Summary == "" {
		t.Error("a job the CLI chose must carry a summary, so the command can say which one it took")
	}
}

// TestVerifySelector_ScopeYieldsToAnExplicitType pins the escape hatch, which is what keeps the
// scope from being a lockout if a third job type ever starts carrying a receipt.
func TestVerifySelector_ScopeYieldsToAnExplicitType(t *testing.T) {
	jobsSelectNoInput(t)
	f := &jobsSelectLister{jobs: verifyJobsSample()}
	ref, err := resolveVerifyJob(f, verifyFlagCmd(t, ""), nil,
		jobSelector{latest: true, jobType: string(types.JobTypeDetectDrift)})
	if err != nil {
		t.Fatalf("resolveVerifyJob --type DETECT_DRIFT: %v", err)
	}
	if ref.ID != "job-drift" {
		t.Errorf("--type DETECT_DRIFT resolved %q, want job-drift — the scope overrode an explicit type", ref.ID)
	}
}

// TestVerifySelector_RefusalNamesTheScope pins the empty answer. "no job" would be false — there
// are jobs, none of them carrying a receipt — and sends the reader looking for one that is right
// there in `jobs list`.
func TestVerifySelector_RefusalNamesTheScope(t *testing.T) {
	jobsSelectNoInput(t)
	noReceipts := []api.ProvisionJob{{
		ID: "job-drift", JobType: string(types.JobTypeDetectDrift), Status: "SUCCESS",
		CreatedAt: time.Date(2026, 3, 9, 12, 0, 0, 0, time.UTC),
	}}
	f := &jobsSelectLister{jobs: noReceipts}
	_, err := resolveVerifyJob(f, verifyFlagCmd(t, ""), nil, jobSelector{latest: true})
	if err == nil {
		t.Fatal("a page with no receipt-bearing job resolved a verify target")
	}
	for _, want := range append([]string{receiptBearingJobScope.Noun}, receiptBearingJobScope.Values...) {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal %q does not name %q", err, want)
		}
	}
}

// --- the --job alias ------------------------------------------------------------------------

// TestVerifySelector_JobFlagIsTheSameAsThePositional pins the back-compatibility promise: `-j`
// was the only way to name a job before this pass, so it is in every pipeline written against the
// old interface, and it must still take the cheapest path — no list request at all.
func TestVerifySelector_JobFlagIsTheSameAsThePositional(t *testing.T) {
	viaFlag := &jobsSelectLister{jobs: verifyJobsSample()}
	fromFlag, err := resolveVerifyJob(viaFlag, verifyFlagCmd(t, "job-7"), nil, jobSelector{})
	if err != nil {
		t.Fatalf("--job job-7: %v", err)
	}
	viaArg := &jobsSelectLister{jobs: verifyJobsSample()}
	fromArg, err := resolveVerifyJob(viaArg, verifyFlagCmd(t, ""), []string{"job-7"}, jobSelector{})
	if err != nil {
		t.Fatalf("positional job-7: %v", err)
	}
	if fromFlag != fromArg {
		t.Errorf("--job resolved %+v and the positional resolved %+v — they must be one source", fromFlag, fromArg)
	}
	if fromFlag.ID != "job-7" {
		t.Errorf("resolved id = %q, want job-7", fromFlag.ID)
	}
	if viaFlag.calls != 0 || viaArg.calls != 0 {
		t.Errorf("an id the operator handed us cost %d/%d list requests", viaFlag.calls, viaArg.calls)
	}
}

// TestVerifySelector_TwoDisagreeingIDsAreRefused: naming the job twice with two different ids is
// a mistake with no right answer. Obeying either one silently reads the wrong job's evidence,
// which is the failure this whole command exists to make impossible.
func TestVerifySelector_TwoDisagreeingIDsAreRefused(t *testing.T) {
	f := &jobsSelectLister{jobs: verifyJobsSample()}
	_, err := resolveVerifyJob(f, verifyFlagCmd(t, "job-b"), []string{"job-a"}, jobSelector{})
	if err == nil {
		t.Fatal("two different ids resolved to one job")
	}
	for _, want := range []string{"job-a", "job-b"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal %q does not name %q, so the reader cannot see which two disagreed", err, want)
		}
	}
	// The same id twice is not a mistake — a script that sets --job and also passes it is odd,
	// not wrong, and refusing it would break the thing the alias exists to protect.
	ref, err := resolveVerifyJob(f, verifyFlagCmd(t, "job-a"), []string{"job-a"}, jobSelector{})
	if err != nil || ref.ID != "job-a" {
		t.Errorf("the same id twice must resolve, got (%+v, %v)", ref, err)
	}
}

// TestVerifySelector_JobFlagWithLatestIsRefused: `--job` lands in the positional slot, so it
// inherits the resolver's id-vs-latest refusal rather than quietly winning.
func TestVerifySelector_JobFlagWithLatestIsRefused(t *testing.T) {
	f := &jobsSelectLister{jobs: verifyJobsSample()}
	if _, err := resolveVerifyJob(f, verifyFlagCmd(t, "job-7"), nil, jobSelector{latest: true}); err == nil {
		t.Error("--job with --latest resolved a job; both name one and obeying either makes the other a lie")
	}
	if _, err := resolveVerifyJob(f, verifyFlagCmd(t, "job-7"), nil,
		jobSelector{jobType: string(types.JobTypePlan)}); err == nil {
		t.Error("--job with a narrowing flag resolved a job; the narrowing would have looked applied")
	}
}

// --- the commands ---------------------------------------------------------------------------

// TestVerifyCmds_TakeTheWholeSelector reads the wiring back off the real cobra commands, so a leaf
// that went back to a required --job fails here rather than in an operator's terminal.
//
// Every flag comes FROM THE SPEC. A hand-written list here would stop covering the moment a
// narrowing field was added, which is the failure mode the spec exists to end.
func TestVerifyCmds_TakeTheWholeSelector(t *testing.T) {
	if len(jobSelectorFields) == 0 {
		t.Fatal("the selector spec is empty — every assertion below is vacuous")
	}
	for _, cmd := range []*cobra.Command{verifyReceiptCmd, verifyShowCmd} {
		if cmd.Args == nil {
			t.Errorf("`%s` declares no Args rule, so it accepts any number of ids", cmd.CommandPath())
			continue
		}
		if err := cmd.ValidateArgs([]string{"job-1"}); err != nil {
			t.Errorf("`%s` rejects the job id as an argument: %v", cmd.CommandPath(), err)
		}
		if err := cmd.ValidateArgs([]string{"job-1", "job-2"}); err == nil {
			t.Errorf("`%s` accepts two job ids", cmd.CommandPath())
		}
		if cmd.Flags().Lookup("latest") == nil {
			t.Errorf("`%s` has no --latest, so it cannot resolve a job without a terminal", cmd.CommandPath())
		}
		for _, f := range jobSelectorFields {
			if cmd.Flags().Lookup(f.Flag) == nil {
				t.Errorf("`%s` has no --%s", cmd.CommandPath(), f.Flag)
			}
		}
		if cmd.InheritedFlags().Lookup("job") == nil {
			t.Errorf("`%s` lost --job; every pipeline written before this pass passes it", cmd.CommandPath())
		}
	}
	// The two leaves must not share one selector value, or narrowing one narrows the other.
	verifyReceiptSelector, verifyShowSelector = jobSelector{}, jobSelector{}
	t.Cleanup(func() { verifyReceiptSelector, verifyShowSelector = jobSelector{}, jobSelector{} })
	if err := verifyReceiptCmd.Flags().Set("type", "PLAN"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = verifyReceiptCmd.Flags().Set("type", "") })
	if verifyReceiptSelector.jobType != "PLAN" {
		t.Errorf("`verify receipt --type PLAN` did not reach its selector, got %q", verifyReceiptSelector.jobType)
	}
	if verifyShowSelector.jobType != "" {
		t.Errorf("`verify receipt --type PLAN` also narrowed `verify show` (%q) — they share a selector",
			verifyShowSelector.jobType)
	}
}

// --- the renderings -------------------------------------------------------------------------

// TestSignatureGlyph_DistinguishesUnestablishedFromVerified is the rendering defect. `Verified` is
// true for a receipt that is merely self-consistent — the forged-receipt shape, and a non-zero
// exit — so a two-state glyph put a tick beside the one verdict a reader most needs to not misread.
func TestSignatureGlyph_DistinguishesUnestablishedFromVerified(t *testing.T) {
	cases := []struct {
		name string
		v    signatureVerdict
		want string
	}{
		{"trusted by the org", signatureVerdict{Verified: true, Trust: string(trustOrg)}, ui.SymbolSuccess},
		{"trusted by the platform", signatureVerdict{Verified: true, Trust: string(trustPlatform)}, ui.SymbolSuccess},
		{"pinned by the operator", signatureVerdict{Verified: true, Trust: string(trustPinned)}, ui.SymbolSuccess},
		{"a custody model we predate", signatureVerdict{Verified: true, Trust: "notary"}, ui.SymbolSuccess},
		{"self-consistent only", signatureVerdict{Verified: true, Trust: string(trustSelf)}, ui.SymbolPending},
		{"unsigned", signatureVerdict{Verified: false, Trust: string(trustNone)}, ui.SymbolError},
		{"tampered", signatureVerdict{Verified: false, Trust: string(trustNone)}, ui.SymbolError},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := signatureGlyph(c.v); got != c.want {
				t.Errorf("glyph = %q, want %q", got, c.want)
			}
		})
	}
	// The distinction, stated as the thing that must not collapse.
	if signatureGlyph(cases[4].v) == signatureGlyph(cases[0].v) {
		t.Error("a self-only signature reads the same as one the org vouches for")
	}
	if signatureGlyph(cases[4].v) == signatureGlyph(cases[5].v) {
		t.Error("a self-only signature reads the same as no signature at all — it is not the same claim")
	}
}

// TestReceiptStampUsesTheSharedDateRule: the card printed the receipt's RFC3339 verbatim while
// `jobs get` printed `9 Mar 2026, 15:04` for the same instant. The expected strings are written
// out rather than computed through format.Date — a test that called the function under test to
// build its own expectation would agree with any rule at all.
func TestReceiptStampUsesTheSharedDateRule(t *testing.T) {
	cases := []struct{ in, want string }{
		{"2026-03-09T15:04:05Z", "9 Mar 2026, 15:04"},
		// An offset is normalised to UTC, so two people reading one receipt read one time.
		{"2026-03-09T17:04:05+02:00", "9 Mar 2026, 15:04"},
		{" 2026-03-09T15:04:05Z ", "9 Mar 2026, 15:04"},
		// Unreadable input survives VERBATIM. This is evidence: a sentinel would destroy the only
		// copy the reader had of what actually arrived.
		{"tuesday", "tuesday"},
		{"", ""},
	}
	for _, c := range cases {
		if got := receiptStamp(c.in); got != c.want {
			t.Errorf("receiptStamp(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestReceiptRowsRenderTheStampThroughTheSharedRule proves the row actually calls it. A formatter
// nothing renders through is a formatter that changed nothing.
func TestReceiptRowsRenderTheStampThroughTheSharedRule(t *testing.T) {
	sr := &verify.SignedReceipt{
		Algorithm: "ed25519",
		Receipt: verify.Receipt{
			Verdict:     verify.StatusPass,
			PlanSHA256:  "3b1f",
			EvaluatedAt: "2026-03-09T15:04:05Z",
		},
	}
	rows := receiptRows(sr, signatureVerdict{Verified: true, Trust: string(trustOrg), Reason: "ok"})
	var evaluated string
	found := false
	for _, r := range rows {
		if r[0] == "Evaluated" {
			evaluated, found = r[1], true
		}
	}
	if !found {
		t.Fatal("the card has no Evaluated row — this test covered nothing")
	}
	if evaluated != "9 Mar 2026, 15:04" {
		t.Errorf("Evaluated = %q, want the shared date rendering", evaluated)
	}
	if strings.Contains(evaluated, "T") || strings.Contains(evaluated, "Z") {
		t.Errorf("Evaluated %q is still the raw RFC3339", evaluated)
	}
}

// TestWriteFindingsRendersTheWaiverExpiryThroughTheSharedRule: the waiver's expiry is the date an
// auditor reads off this line, and it was the second raw RFC3339 in the group.
func TestWriteFindingsRendersTheWaiverExpiryThroughTheSharedRule(t *testing.T) {
	var out strings.Builder
	writeFindings(&out, sampleReport(), &verify.RecordedException{
		Controls: []string{"KEYLESS-001"},
		By:       "sre@acme.io",
		Reason:   "legacy account",
		Expiry:   "2026-03-09T15:04:05Z",
	})
	got := out.String()
	if !strings.Contains(got, "expires 9 Mar 2026, 15:04") {
		t.Errorf("the waiver expiry is not rendered through the shared rule:\n%s", got)
	}
	if strings.Contains(got, "2026-03-09T15:04:05Z") {
		t.Errorf("the raw RFC3339 is still printed:\n%s", got)
	}
}

// --- the docs page --------------------------------------------------------------------------

// verifyDocsPath is the group's docs page, resolved from this package.
const verifyDocsPath = "../../../apps/docs/content/docs/cli/commands/verify.mdx"

// TestVerifyDocs_SelectorTableMatchesTheSpec compares the flags the page documents against the
// flags the spec produces, in both directions. The docs are a SEPARATE artifact — nothing
// generates them — so a field added to the spec and not documented fails here, and a flag
// documented that no longer exists fails here too.
func TestVerifyDocs_SelectorTableMatchesTheSpec(t *testing.T) {
	raw, err := os.ReadFile(verifyDocsPath)
	if err != nil {
		t.Fatalf("the verify docs page must ship with the verify commands: %v", err)
	}
	const heading = "## Choosing the job"
	start := strings.Index(string(raw), heading)
	if start < 0 {
		t.Fatalf("%s has no %q section — this test would otherwise pass by finding no rows", verifyDocsPath, heading)
	}
	section := string(raw)[start+len(heading):]
	if next := strings.Index(section, "\n## "); next >= 0 {
		section = section[:next]
	}

	documented := map[string]bool{}
	for _, m := range jobsDocsFlagRow.FindAllStringSubmatch(section, -1) {
		documented[m[1]] = true
	}
	if len(documented) == 0 {
		t.Fatalf("the %q section documents no flags — vacuous", heading)
	}

	want := map[string]bool{"--latest": true, "--job": true}
	for _, f := range jobSelectorFields {
		want["--"+f.Flag] = true
	}
	for flag := range want {
		if !documented[flag] {
			t.Errorf("%s is part of the verify selector and is not in the %q table", flag, heading)
		}
	}
	for flag := range documented {
		if !want[flag] {
			t.Errorf("%s is documented in the %q table and is not part of the verify selector", flag, heading)
		}
	}
	// The scope is behaviour an operator cannot check from anywhere but this page.
	for _, v := range receiptBearingJobScope.Values {
		if !strings.Contains(section, v) {
			t.Errorf("the %q section does not say that %s is one of the types --latest considers", heading, v)
		}
	}
}

// TestVerifyDocs_CarryNoCopiedJobID is the handoff gate for this group's page. A `<job-id>`
// placeholder in a command line is a token the reader has to copy out of a previous command's
// output, and removing those is what the CLI programme is measured on.
func TestVerifyDocs_CarryNoCopiedJobID(t *testing.T) {
	raw, err := os.ReadFile(verifyDocsPath)
	if err != nil {
		t.Fatalf("reading %s: %v", verifyDocsPath, err)
	}
	lines := strings.Split(string(raw), "\n")
	seen := 0
	for i, line := range lines {
		if !strings.Contains(line, "alethia verify") {
			continue
		}
		seen++
		for _, placeholder := range []string{"<job_id>", "<job-id>", "<id>", "<plan-job-id>", "<apply-job-id>"} {
			if strings.Contains(line, placeholder) {
				t.Errorf("%s:%d hands the reader a %s to copy: %s", verifyDocsPath, i+1, placeholder, strings.TrimSpace(line))
			}
		}
	}
	if seen == 0 {
		t.Fatalf("%s shows no `alethia verify` command lines — this test covered nothing", verifyDocsPath)
	}
}
