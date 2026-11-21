// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// The BYO commands and the family's reads through the one writer: what each mutation prints for a
// program, what a scan's --wait reports, and which stream and exit code each refusal has.

// byoMutationDoc is a BYO MutationResult as a program reads it.
type byoMutationDoc struct {
	ID     string  `json:"id"`
	Kind   string  `json:"kind"`
	Action string  `json:"action"`
	Job    *JobRef `json:"job"`
	DryRun bool    `json:"dry_run"`
	Object struct {
		Project   string   `json:"project"`
		Env       string   `json:"env"`
		RepoURL   string   `json:"repo_url"`
		ChartPath string   `json:"chart_path"`
		Path      string   `json:"path"`
		JobStatus string   `json:"job_status"`
		Warnings  []string `json:"warnings"`
	} `json:"object"`
}

// decodeByoMutation prints result as json and reads it back, failing on anything but one document.
func decodeByoMutation(t *testing.T, result MutationResult) byoMutationDoc {
	t.Helper()
	var out bytes.Buffer
	if err := testPrinter(&out, ui.FormatJSON).Result(result, nil); err != nil {
		t.Fatalf("Result: %v", err)
	}
	var doc byoMutationDoc
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("not one json document: %v\n%s", err, out.String())
	}
	return doc
}

// byoJobPoller answers GetJob with a fixed job.
type byoJobPoller struct{ job *api.ProvisionJob }

// GetJob returns the configured job.
func (p byoJobPoller) GetJob(string) (*api.ProvisionJob, error) { return p.job, nil }

func TestByoFamily_EachMutationPrintsOneResult(t *testing.T) {
	f := &fakeClient{attachResult: &api.ByoAttachResult{OK: true, ID: "my-api"}}
	p := testPrinter(&bytes.Buffer{}, ui.FormatJSON)
	ctx := context.Background()

	attach, err := chartAttach(f, api.AttachChartParams{Project: "shop", Env: "staging", ID: "My API", RepoURL: "https://github.com/acme/charts", ChartPath: "charts/api"})
	if err != nil {
		t.Fatalf("chartAttach: %v", err)
	}
	detach, err := chartDetach(f, "shop", "staging", "my-api")
	if err != nil {
		t.Fatalf("chartDetach: %v", err)
	}
	scan, err := chartScan(ctx, p, f, waitFlags{}, "shop", "staging", "my-api")
	if err != nil {
		t.Fatalf("chartScan: %v", err)
	}
	iacA, err := iacAttach(f, api.AttachIacParams{Project: "shop", Env: "staging", RepoURL: "https://github.com/acme/infra", Path: "iac/aws"})
	if err != nil {
		t.Fatalf("iacAttach: %v", err)
	}
	iacD, err := iacDetach(f, "shop", "staging")
	if err != nil {
		t.Fatalf("iacDetach: %v", err)
	}
	iacS, err := iacScan(ctx, p, f, waitFlags{}, "shop", "staging")
	if err != nil {
		t.Fatalf("iacScan: %v", err)
	}

	for _, tc := range []struct {
		name    string
		result  MutationResult
		id      string
		kind    string
		action  string
		jobType string
	}{
		{"chart attach", attach, "my-api", byoChartKind, "updated", ""},
		{"chart detach", detach, "my-api", byoChartKind, "deleted", ""},
		{"chart scan", scan, "my-api", byoChartKind, "queued", chartScanJobType},
		{"iac attach", iacA, "iac-1", byoIacKind, "updated", ""},
		{"iac detach", iacD, "", byoIacKind, "deleted", ""},
		{"iac scan", iacS, "", byoIacKind, "queued", iacScanJobType},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := decodeByoMutation(t, tc.result)
			if doc.ID != tc.id || doc.Kind != tc.kind || doc.Action != tc.action || doc.DryRun {
				t.Errorf("result = %+v", doc)
			}
			if doc.Object.Project != "shop" || doc.Object.Env != "staging" {
				t.Errorf("the target is not in the object: %+v", doc.Object)
			}
			switch {
			case tc.jobType == "" && doc.Job != nil:
				t.Errorf("nothing was queued, yet the result names job %+v", doc.Job)
			case tc.jobType != "" && (doc.Job == nil || doc.Job.Type != tc.jobType || doc.Job.ID == ""):
				t.Errorf("job = %+v, want a %s job with its id", doc.Job, tc.jobType)
			}
		})
	}
	if doc := decodeByoMutation(t, attach); doc.Object.RepoURL != "https://github.com/acme/charts" || doc.Object.ChartPath != "charts/api" {
		t.Errorf("chart attach object = %+v", doc.Object)
	}
	if doc := decodeByoMutation(t, scan); doc.Object.JobStatus != jobStatusQueued || doc.Object.Warnings == nil {
		t.Errorf("an unwaited scan reports its queued status and an empty warning list: %+v", doc.Object)
	}
}

// TestByoFamily_ScanWaitsForTheVerdict is the spec's acceptance line for `iac scan` and `chart scan`:
// both take --wait, and the wait's ending decides the exit code.
func TestByoFamily_ScanWaitsForTheVerdict(t *testing.T) {
	prev := jobPollInterval
	jobPollInterval = 0
	t.Cleanup(func() { jobPollInterval = prev })
	queued := &api.ByoScanResult{OK: true, JobID: "job-7"}
	target := byoTarget{Project: "shop", Env: "staging"}
	wait := waitFlags{Wait: true}

	t.Run("a finished scan reports its final status and its warnings", func(t *testing.T) {
		p, out, errOut := splitPrinter(ui.FormatTable)
		meta := map[string]interface{}{"gitops_status": map[string]interface{}{
			"manifest_warnings": []interface{}{"variable region has no default"},
		}}
		job := &api.ProvisionJob{ID: "job-7", Status: jobStatusSuccess, ExecutionMetadata: &meta}
		r, err := followByoScan(context.Background(), p, byoJobPoller{job}, wait, MutationResult{Kind: byoIacKind, Action: ResultQueued},
			iacScanJobType, target, queued)
		if err != nil {
			t.Fatalf("followByoScan: %v", err)
		}
		obj, _ := r.Object.(byoScanObject)
		if obj.JobStatus != jobStatusSuccess {
			t.Errorf("job status = %q, want the final one", obj.JobStatus)
		}
		if err := printByoScan(p, r, "IaC source"); err != nil {
			t.Fatalf("printByoScan: %v", err)
		}
		if !strings.Contains(out.String(), "finished (job job-7)") {
			t.Errorf("stdout = %q, want the finished line", out.String())
		}
		if strings.Contains(errOut.String(), "Follow it") {
			t.Errorf("a finished scan has nothing to follow: %q", errOut.String())
		}
		if len(obj.Warnings) != 1 || !strings.Contains(errOut.String(), "variable region has no default") {
			t.Errorf("the job's warning = %v, stderr %q", obj.Warnings, errOut.String())
		}
	})

	t.Run("a failed scan exits 13", func(t *testing.T) {
		p, _, _ := splitPrinter(ui.FormatJSON)
		job := &api.ProvisionJob{ID: "job-7", Status: jobStatusFailed}
		_, err := followByoScan(context.Background(), p, byoJobPoller{job}, wait, MutationResult{Kind: byoChartKind},
			chartScanJobType, target, queued)
		if e := clierr.From(err); e == nil || e.Exit != 13 {
			t.Fatalf("err = %v, want operation_failed (exit 13)", err)
		}
	})

	t.Run("a scan with no job id has nothing to wait for and says so", func(t *testing.T) {
		p, out, errOut := splitPrinter(ui.FormatTable)
		r, err := followByoScan(context.Background(), p, byoJobPoller{}, wait, MutationResult{Kind: byoChartKind},
			chartScanJobType, target, &api.ByoScanResult{OK: true})
		if err != nil {
			t.Fatalf("followByoScan: %v", err)
		}
		if r.Job != nil {
			t.Errorf("no job id was sent, yet the result names %+v", r.Job)
		}
		if !strings.Contains(errOut.String(), "nothing to wait for") {
			t.Errorf("stderr = %q", errOut.String())
		}
		if out.Len() != 0 {
			t.Errorf("the warning reached stdout: %q", out.String())
		}
	})
}

// TestByoFamily_RefusalsAreTypedAndSendNothing walks every refusal the family raises before a
// request: each has its own exit code and says what to pass.
func TestByoFamily_RefusalsAreTypedAndSendNothing(t *testing.T) {
	f := &fakeClient{}
	p := testPrinter(&bytes.Buffer{}, ui.FormatJSON)
	ctx := context.Background()
	_, attachNoRepo := chartAttach(f, api.AttachChartParams{ID: "api"})
	_, attachNothing := chartAttach(f, api.AttachChartParams{})
	_, iacNoRepo := iacAttach(f, api.AttachIacParams{})
	_, detachNoID := chartDetach(f, "shop", "", "")
	_, scanNoID := chartScan(ctx, p, f, waitFlags{}, "shop", "", "")
	_, resolveNoID := resolveChartID(f, "", "shop", "", false, byoKeyChartID, "alethia chart detach")
	_, valuesFile := readChartValuesFile("/nonexistent/values.yaml")
	for _, tc := range []struct {
		name string
		err  error
		exit int
	}{
		{"chart attach without --repo", attachNoRepo, 9},
		{"chart attach without id or --repo", attachNothing, 9},
		{"iac attach without --repo", iacNoRepo, 9},
		{"chart detach without an id", detachNoID, 8},
		{"chart scan without an id", scanNoID, 8},
		{"a chart id nobody can be asked for", resolveNoID, 9},
		{"an unreadable --values-file", valuesFile, 8},
	} {
		if e := clierr.From(tc.err); e == nil || e.Exit != tc.exit {
			t.Errorf("%s: err = %v, want exit %d", tc.name, tc.err, tc.exit)
		}
	}
	if !strings.Contains(attachNothing.Error(), "are required") {
		t.Errorf("two missing values read as one: %v", attachNothing)
	}
	if f.attachedChart.ID != "" || f.attachedIac.RepoURL != "" || len(f.byoDetached) != 0 || len(f.byoScanned) != 0 {
		t.Errorf("a refusal reached the control plane: %+v", f)
	}
}

// A not-found answer gains the listing command as its hint; any other answer is left as it came.
func TestByoFamily_NotFoundNamesWhereTheNamesAre(t *testing.T) {
	_, err := chartDetach(&fakeClient{err: &api.APIError{StatusCode: http.StatusNotFound, Message: "no such chart"}}, "shop", "", "api")
	e := clierr.From(err)
	if e.Exit != 6 || e.Hint != "alethia chart list" {
		t.Errorf("not found = exit %d hint %q, want exit 6 and the list command", e.Exit, e.Hint)
	}
	_, err = iacScan(context.Background(), testPrinter(&bytes.Buffer{}, ui.FormatJSON),
		&fakeClient{err: &api.APIError{StatusCode: http.StatusForbidden, Message: "no"}}, waitFlags{}, "shop", "")
	if e := clierr.From(err); e.Exit != 5 || e.Hint != "" {
		t.Errorf("forbidden = exit %d hint %q, want exit 5 and no invented hint", e.Exit, e.Hint)
	}
}

// A result that could not be written is an error, never a silent success.
func TestByoFamily_AFailedWriteIsReported(t *testing.T) {
	broken := &Printer{Out: failingWriter{}, Err: &bytes.Buffer{}, Format: ui.FormatJSON}
	r := MutationResult{ID: "api", Kind: byoChartKind}
	for name, err := range map[string]error{
		"chart attach": printChartAttach(broken, r),
		"iac attach":   printIacAttach(broken, r),
		"scan":         printByoScan(broken, r, "chart api"),
		"addon enable": printAddonEnable(broken, r),
		"addon bump":   printAddonBump(broken, r),
	} {
		if !errors.Is(err, errBoom) {
			t.Errorf("%s: err = %v, want the write failure", name, err)
		}
	}
}

// With nobody to ask, a project picker that cannot open is the input-required refusal naming the
// flag, whichever way the group reaches the picker.
func TestByoFamily_AProjectPickerThatCannotOpenNamesTheFlag(t *testing.T) {
	prev := noInputMode
	noInputMode = true
	t.Cleanup(func() { noInputMode = prev })
	_, err := byoProject(byoFormProjectCmd(t, ""), "tok", true)
	if e := clierr.From(err); e.Exit != 9 || !strings.Contains(e.Message, "--project") {
		t.Errorf("byoProject = %v (exit %d), want input_required naming --project", err, e.Exit)
	}
}

// TestByoFamily_EndToEnd drives the real tree: the result is the only thing on stdout, and each
// refusal is on stderr with its exit code.
func TestByoFamily_EndToEnd(t *testing.T) {
	t.Run("iac scan -o json prints one result carrying the job", func(t *testing.T) {
		run, _ := byoEnv(t, http.StatusOK)
		var exited bool
		var code int
		stdout, stderr := captureStreams(t, func() {
			exited, code, _ = connInvoke(t, run, "iac", "scan", "-p", "shop", "-e", "dev", "-o", "json")
		})
		if exited {
			t.Fatalf("unexpected fatal exit %d: %s", code, stderr)
		}
		var doc byoMutationDoc
		if err := json.Unmarshal([]byte(stdout), &doc); err != nil {
			t.Fatalf("stdout is not one json document: %v\n%s", err, stdout)
		}
		if doc.Action != "queued" || doc.Job == nil || doc.Job.ID != "job-9" || doc.Job.Type != iacScanJobType {
			t.Errorf("result = %+v", doc)
		}
	})

	for _, tc := range []struct {
		name string
		args []string
		exit int
		says string
	}{
		{"chart attach with nobody to ask for --repo", []string{"chart", "attach", "api", "-p", "shop", "--no-input"}, 9, "--repo"},
		{"chart detach without --yes", []string{"chart", "detach", "api", "-p", "shop", "--no-input"}, 9, "--yes"},
		{"iac detach without --yes", []string{"iac", "detach", "-p", "shop", "--no-input"}, 9, "--yes"},
		{"iac scan with nobody to ask for --project", []string{"iac", "scan", "--no-input"}, 9, "--project"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run, rec := byoEnv(t, http.StatusOK)
			var exited bool
			var code int
			stdout, stderr := captureStreams(t, func() {
				exited, code, _ = connInvoke(t, run, tc.args...)
			})
			if !exited || code != tc.exit {
				t.Errorf("exited=%v code=%d, want exit %d", exited, code, tc.exit)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote to stdout: %q", stdout)
			}
			if !strings.Contains(stderr, tc.says) {
				t.Errorf("stderr does not name %q: %q", tc.says, stderr)
			}
			if len(rec.calls) != 0 {
				t.Errorf("a refusal sent %+v", rec.calls)
			}
		})
	}
}

// TestReadsFamily_RefusalsAreTyped pins the reads' one refusal — a project nobody named and nobody
// can be asked for — as input_required on stderr, for each way the family resolves a project.
func TestReadsFamily_RefusalsAreTyped(t *testing.T) {
	for _, args := range [][]string{
		{"cost", "show", "--no-input"},
		{"drift", "show", "--no-input"},
		{"probes", "list", "--no-input"},
		{"promotion", "list", "--no-input"},
		{"addon", "list", "--no-input"},
	} {
		t.Run(strings.Join(args[:2], " "), func(t *testing.T) {
			_, run := hygCliConfirmEnv(t)
			var code int
			stdout, stderr := captureStreams(t, func() { code = run(args...) })
			if code != 9 {
				t.Errorf("exit code = %d, want 9", code)
			}
			if stdout != "" {
				t.Errorf("a refusal wrote to stdout: %q", stdout)
			}
			if !strings.Contains(stderr, "--project") {
				t.Errorf("stderr does not name --project: %q", stderr)
			}
		})
	}
}
