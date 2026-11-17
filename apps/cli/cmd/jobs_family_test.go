// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

// The jobs family against a fake control plane: what each command writes on which stream, the
// shape of its json, and the exit code each way of failing owns.

// famApplyMeta puts the registry's facts on the tree, as Execute does before it runs a command:
// the examples, the annotations and the --dry-run flag a mutating command's entry declares. The
// tests drive rootCmd directly, so without this the flag the docs name would not be registered.
func famApplyMeta(t *testing.T) {
	t.Helper()
	applyCommandMeta()
}

// famPrinter is a Printer over two buffers, so a test reads exactly what a command would print.
func famPrinter(format string) (*Printer, *bytes.Buffer, *bytes.Buffer) {
	out, errOut := &bytes.Buffer{}, &bytes.Buffer{}
	return &Printer{Out: out, Err: errOut, Format: format}, out, errOut
}

// famExit returns the exit code err owns, or 0 for nil.
func famExit(err error) int {
	if err == nil {
		return 0
	}
	return clierr.From(err).Exit
}

// famLogSource is a scripted control plane for the log reader. Each call to GetJobLogs and GetJob
// takes the next scripted answer; the last one repeats.
type famLogSource struct {
	logs     []famLogAnswer
	jobs     []famJobAnswer
	logCalls int
	jobCalls int
}

type famLogAnswer struct {
	chunks []api.JobLog
	err    error
}

type famJobAnswer struct {
	job *api.ProvisionJob
	err error
}

func (s *famLogSource) GetJobLogs(_ string, _ int) ([]api.JobLog, error) {
	i := min(s.logCalls, len(s.logs)-1)
	s.logCalls++
	return s.logs[i].chunks, s.logs[i].err
}

func (s *famLogSource) GetJob(_ string) (*api.ProvisionJob, error) {
	i := min(s.jobCalls, len(s.jobs)-1)
	s.jobCalls++
	return s.jobs[i].job, s.jobs[i].err
}

// famJob builds a job in one status, with the deploy warnings given.
func famJob(status string, warnings ...string) *api.ProvisionJob {
	job := &api.ProvisionJob{ID: "j1", JobType: "DEPLOY", Status: status, CreatedAt: time.Unix(1_700_000_000, 0)}
	if len(warnings) > 0 {
		list := make([]interface{}, len(warnings))
		for i, w := range warnings {
			list[i] = w
		}
		meta := map[string]interface{}{"gitops_status": map[string]interface{}{"manifest_warnings": list}}
		job.ExecutionMetadata = &meta
	}
	return job
}

// famFastLogPolls makes a follow poll at once.
func famFastLogPolls(t *testing.T) {
	t.Helper()
	prev := jobsLogsPollInterval
	jobsLogsPollInterval = time.Millisecond
	t.Cleanup(func() { jobsLogsPollInterval = prev })
}

// famChunk is one log line.
func famChunk(id int, text string) api.JobLog {
	return api.JobLog{ID: id, JobID: "j1", LogChunk: text, StreamType: "STDOUT"}
}

// TestJobLogs_FollowExitsWithTheJobsResult is the defect this family exists to close: a follow of
// a job that failed, or was cancelled, used to return normally.
func TestJobLogs_FollowExitsWithTheJobsResult(t *testing.T) {
	famFastLogPolls(t)
	cases := map[string]int{
		"SUCCESS":   clierr.ExitOK,
		"FAILED":    clierr.ExitOperationFailed,
		"CANCELLED": clierr.ExitOperationFailed,
	}
	for status, want := range cases {
		t.Run(status, func(t *testing.T) {
			src := &famLogSource{
				logs: []famLogAnswer{{chunks: []api.JobLog{famChunk(1, "applying\n")}}, {}},
				jobs: []famJobAnswer{{job: famJob("PROCESSING")}, {job: famJob(status)}},
			}
			p, out, errOut := famPrinter(ui.FormatTable)
			err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{Follow: true})
			if got := famExit(err); got != want {
				t.Fatalf("exit = %d (%v), want %d", got, err, want)
			}
			if out.String() != "applying\n" {
				t.Errorf("stdout carries more than the log: %q", out)
			}
			if !strings.Contains(errOut.String(), status) {
				t.Errorf("stderr does not close with the status: %q", errOut)
			}
			if want != clierr.ExitOK {
				e := clierr.From(err)
				if e.Operation == nil || e.Operation.ID != "j1" || e.Operation.Type != "DEPLOY" {
					t.Errorf("the error does not name the job: %+v", e.Operation)
				}
				if e.Hint != "alethia jobs get j1" {
					t.Errorf("hint = %q", e.Hint)
				}
			}
		})
	}
}

// TestJobLogs_FollowSurvivesAFailedFetch: one poll that fails for a passing reason does not end a
// follow, whether it was the log fetch or the status read that failed.
func TestJobLogs_FollowSurvivesAFailedFetch(t *testing.T) {
	famFastLogPolls(t)
	blip := &api.TransportError{Err: errors.New("connection reset")}
	src := &famLogSource{
		logs: []famLogAnswer{
			{chunks: []api.JobLog{famChunk(1, "one\n")}},
			{err: blip},
			{chunks: []api.JobLog{famChunk(2, "two\n")}},
			{},
		},
		jobs: []famJobAnswer{
			{job: famJob("PROCESSING")},
			{err: &api.APIError{StatusCode: http.StatusBadGateway, Message: "bad gateway"}},
			{job: famJob("SUCCESS")},
		},
	}
	p, out, _ := famPrinter(ui.FormatTable)
	if err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{Follow: true}); err != nil {
		t.Fatalf("a follow with two passing failures ended with %v", err)
	}
	if out.String() != "one\ntwo\n" {
		t.Errorf("stdout = %q, want both chunks and nothing else", out)
	}
}

// TestJobLogs_FollowGivesUpOnAnOutageAndOnARefusal: the retry is bounded, and an error no retry
// can fix ends the follow at once with that error's own class.
func TestJobLogs_FollowGivesUpOnAnOutageAndOnARefusal(t *testing.T) {
	famFastLogPolls(t)
	t.Run("an outage", func(t *testing.T) {
		src := &famLogSource{
			logs: []famLogAnswer{{err: &api.TransportError{Err: errors.New("no route")}}},
			jobs: []famJobAnswer{{job: famJob("PROCESSING")}},
		}
		p, out, _ := famPrinter(ui.FormatTable)
		err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{Follow: true})
		if got := famExit(err); got != clierr.ExitUnavailable {
			t.Fatalf("exit = %d (%v), want %d", got, err, clierr.ExitUnavailable)
		}
		if src.logCalls != maxPollFailures {
			t.Errorf("fetched %d times, want %d", src.logCalls, maxPollFailures)
		}
		if out.Len() != 0 {
			t.Errorf("stdout is not empty on failure: %q", out)
		}
	})
	t.Run("a job that is not there", func(t *testing.T) {
		src := &famLogSource{
			logs: []famLogAnswer{{err: &api.APIError{StatusCode: http.StatusNotFound, Message: "Job not found"}}},
			jobs: []famJobAnswer{{job: famJob("PROCESSING")}},
		}
		p, _, _ := famPrinter(ui.FormatTable)
		err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{Follow: true})
		if got := famExit(err); got != clierr.ExitNotFound {
			t.Fatalf("exit = %d (%v), want %d", got, err, clierr.ExitNotFound)
		}
		if src.logCalls != 1 {
			t.Errorf("a refusal was retried: %d fetches", src.logCalls)
		}
		if clierr.From(err).Hint != "alethia jobs list" {
			t.Errorf("hint = %q", clierr.From(err).Hint)
		}
	})
}

// TestJobLogs_FollowTimeoutAndInterrupt: the two ways a follow stops with the job still running
// each own an exit code, and each error names the job so the caller can resume.
func TestJobLogs_FollowTimeoutAndInterrupt(t *testing.T) {
	famFastLogPolls(t)
	running := func() *famLogSource {
		return &famLogSource{logs: []famLogAnswer{{}}, jobs: []famJobAnswer{{job: famJob("PROCESSING")}}}
	}
	t.Run("timeout", func(t *testing.T) {
		p, _, _ := famPrinter(ui.FormatTable)
		err := runJobLogs(context.Background(), running(), p, "j1", jobLogsOptions{Follow: true, Timeout: 20 * time.Millisecond})
		e := clierr.From(err)
		if e == nil || e.Exit != clierr.ExitWaitTimeout {
			t.Fatalf("got %v, want the wait-timeout exit %d", err, clierr.ExitWaitTimeout)
		}
		if e.Operation == nil || e.Operation.ID != "j1" || !strings.Contains(e.Hint, "jobs logs j1 --follow") {
			t.Errorf("the timeout does not say how to resume: op %+v hint %q", e.Operation, e.Hint)
		}
	})
	t.Run("interrupt", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		p, _, _ := famPrinter(ui.FormatTable)
		err := runJobLogs(ctx, running(), p, "j1", jobLogsOptions{Follow: true})
		if got := famExit(err); got != clierr.ExitInterrupted {
			t.Fatalf("exit = %d (%v), want %d", got, err, clierr.ExitInterrupted)
		}
	})
}

// TestJobLogs_PlainReadIsOneFetchAndExitsZero: without --follow the command reports what was
// written and makes no claim about the job, so a failed job's log is still exit 0.
func TestJobLogs_PlainReadIsOneFetchAndExitsZero(t *testing.T) {
	src := &famLogSource{
		logs: []famLogAnswer{{chunks: []api.JobLog{famChunk(1, "boom\n")}}},
		jobs: []famJobAnswer{{job: famJob("FAILED")}},
	}
	p, out, errOut := famPrinter(ui.FormatTable)
	if err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{}); err != nil {
		t.Fatal(err)
	}
	if src.logCalls != 1 || src.jobCalls != 0 {
		t.Errorf("a plain read made %d log and %d status calls, want 1 and 0", src.logCalls, src.jobCalls)
	}
	if out.String() != "boom\n" || errOut.Len() != 0 {
		t.Errorf("stdout %q stderr %q", out, errOut)
	}
}

// TestJobLogs_JSONIsOneDocument pins the json form: one object, the chunks in order, and the final
// status only when the read followed the job to it.
func TestJobLogs_JSONIsOneDocument(t *testing.T) {
	famFastLogPolls(t)
	type doc struct {
		JobID  string       `json:"job_id"`
		Status *string      `json:"status"`
		Logs   []api.JobLog `json:"logs"`
	}
	t.Run("plain", func(t *testing.T) {
		src := &famLogSource{logs: []famLogAnswer{{}}, jobs: []famJobAnswer{{job: famJob("PROCESSING")}}}
		p, out, _ := famPrinter(ui.FormatJSON)
		if err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{}); err != nil {
			t.Fatal(err)
		}
		var got doc
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("stdout is not one json document: %v\n%s", err, out)
		}
		if got.JobID != "j1" || got.Status != nil || got.Logs == nil || len(got.Logs) != 0 {
			t.Errorf("got %+v, want the job id, no status and an empty logs array", got)
		}
	})
	t.Run("followed to a failure", func(t *testing.T) {
		src := &famLogSource{
			logs: []famLogAnswer{{chunks: []api.JobLog{famChunk(1, "a\n")}}, {chunks: []api.JobLog{famChunk(2, "b\n")}}},
			jobs: []famJobAnswer{{job: famJob("FAILED")}},
		}
		p, out, errOut := famPrinter(ui.FormatJSON)
		err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{Follow: true})
		if got := famExit(err); got != clierr.ExitOperationFailed {
			t.Fatalf("exit = %d, want %d", got, clierr.ExitOperationFailed)
		}
		var got doc
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("stdout is not one json document: %v\n%s", err, out)
		}
		if got.Status == nil || *got.Status != "FAILED" || len(got.Logs) != 2 {
			t.Errorf("got %+v, want status FAILED and both chunks", got)
		}
		if errOut.Len() != 0 {
			t.Errorf("a json read wrote on stderr: %q", errOut)
		}
	})
	t.Run("csv is refused", func(t *testing.T) {
		src := &famLogSource{logs: []famLogAnswer{{}}, jobs: []famJobAnswer{{job: famJob("SUCCESS")}}}
		p, out, _ := famPrinter(ui.FormatCSV)
		err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{})
		if got := famExit(err); got != clierr.ExitUsage || out.Len() != 0 || src.logCalls != 0 {
			t.Errorf("exit %d, stdout %q, %d fetches — want a usage refusal before any request", got, out, src.logCalls)
		}
	})
}

// TestJobLogs_FollowPrintsADeploysWarnings: a deploy that succeeded with warnings says so when the
// follow ends, on stderr, and still exits 0.
func TestJobLogs_FollowPrintsADeploysWarnings(t *testing.T) {
	famFastLogPolls(t)
	src := &famLogSource{
		logs: []famLogAnswer{{}},
		jobs: []famJobAnswer{{job: famJob("SUCCESS", "api: repo-sourced service not built yet")}},
	}
	p, out, errOut := famPrinter(ui.FormatTable)
	if err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{Follow: true}); err != nil {
		t.Fatalf("a deploy with warnings must still exit 0, got %v", err)
	}
	if !strings.Contains(errOut.String(), "api: repo-sourced service not built yet") {
		t.Errorf("stderr does not carry the warning: %q", errOut)
	}
	if strings.Contains(out.String(), "repo-sourced") {
		t.Errorf("the warning reached stdout: %q", out)
	}
}

// TestJobLogsOptions_TimeoutNeedsFollow: a --timeout with nothing to bound is refused before any
// request, as a usage error.
func TestJobLogsOptions_TimeoutNeedsFollow(t *testing.T) {
	if err := (jobLogsOptions{Follow: true, Timeout: time.Minute}).validate(); err != nil {
		t.Errorf("a bounded follow was refused: %v", err)
	}
	if err := (jobLogsOptions{}).validate(); err != nil {
		t.Errorf("a plain read was refused: %v", err)
	}
	for _, o := range []jobLogsOptions{{Timeout: time.Minute}, {Follow: true, Timeout: -time.Second}} {
		if got := famExit(o.validate()); got != clierr.ExitUsage {
			t.Errorf("%+v: exit %d, want %d", o, got, clierr.ExitUsage)
		}
	}
}

// --- jobs get ---

// famJobGetter serves one job, or one error.
type famJobGetter struct {
	job *api.ProvisionJob
	err error
}

func (g famJobGetter) GetJob(string) (*api.ProvisionJob, error) { return g.job, g.err }

// TestJobGet_WarningsAreAnArrayInJSONAndLinesOnStderr pins both renderings of a deploy's warnings,
// and that a job without any still carries the key.
func TestJobGet_WarningsAreAnArrayInJSONAndLinesOnStderr(t *testing.T) {
	const first, second = "api: repo-sourced service not built yet", "add-on loki did not sync"

	t.Run("json", func(t *testing.T) {
		view, err := runJobGet(famJobGetter{job: famJob("SUCCESS", first, second)}, "j1")
		if err != nil {
			t.Fatal(err)
		}
		p, out, errOut := famPrinter(ui.FormatJSON)
		if err := view.print(p); err != nil {
			t.Fatal(err)
		}
		var got struct {
			ID       string   `json:"id"`
			Status   string   `json:"status"`
			Warnings []string `json:"warnings"`
		}
		if err := json.Unmarshal(out.Bytes(), &got); err != nil {
			t.Fatalf("not json: %v\n%s", err, out)
		}
		if got.ID != "j1" || got.Status != "SUCCESS" {
			t.Errorf("the job's own fields are no longer at the top level: %+v", got)
		}
		if len(got.Warnings) != 2 || got.Warnings[0] != first || got.Warnings[1] != second {
			t.Errorf("warnings = %q", got.Warnings)
		}
		if errOut.Len() != 0 {
			t.Errorf("a json read wrote on stderr: %q", errOut)
		}
	})

	t.Run("json with none", func(t *testing.T) {
		view, err := runJobGet(famJobGetter{job: famJob("SUCCESS")}, "j1")
		if err != nil {
			t.Fatal(err)
		}
		p, out, _ := famPrinter(ui.FormatJSON)
		if err := view.print(p); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), `"warnings": []`) {
			t.Errorf("a job without warnings must carry an empty array, not a missing or null key:\n%s", out)
		}
	})

	t.Run("card", func(t *testing.T) {
		view, err := runJobGet(famJobGetter{job: famJob("SUCCESS", first, second)}, "j1")
		if err != nil {
			t.Fatal(err)
		}
		p, out, errOut := famPrinter(ui.FormatTable)
		if err := view.print(p); err != nil {
			t.Fatalf("warnings must not fail the command: %v", err)
		}
		if strings.Contains(out.String(), first) {
			t.Errorf("a warning reached stdout: %q", out)
		}
		for _, w := range []string{first, second, "2 warnings"} {
			if !strings.Contains(errOut.String(), w) {
				t.Errorf("stderr does not say %q: %q", w, errOut)
			}
		}
	})
}

// TestJobWarnings_ReadsOnlyTheSentences: anything that is not the list of sentences yields none.
func TestJobWarnings_ReadsOnlyTheSentences(t *testing.T) {
	meta := func(v interface{}) *api.ProvisionJob {
		m := map[string]interface{}{"gitops_status": v}
		return &api.ProvisionJob{ExecutionMetadata: &m}
	}
	empty := []*api.ProvisionJob{
		nil,
		{},
		meta("not an object"),
		meta(map[string]interface{}{}),
		meta(map[string]interface{}{"manifest_warnings": "one string"}),
		meta(map[string]interface{}{"manifest_warnings": []interface{}{7, "  ", nil}}),
	}
	for i, job := range empty {
		if got := jobWarnings(job); got == nil || len(got) != 0 {
			t.Errorf("case %d: got %#v, want an empty, non-nil list", i, got)
		}
	}
}

// TestJobGet_AMissingJobExitsNotFoundWithAHint: the refusal's exit code, and its next step.
func TestJobGet_AMissingJobExitsNotFoundWithAHint(t *testing.T) {
	_, err := runJobGet(famJobGetter{err: &api.APIError{StatusCode: http.StatusNotFound, Message: "Job not found"}}, "j9")
	e := clierr.From(err)
	if e == nil || e.Exit != clierr.ExitNotFound || e.Hint != "alethia jobs list" {
		t.Fatalf("got %+v, want not_found with the list hint", e)
	}
	if !strings.Contains(e.Message, "j9") {
		t.Errorf("the message does not name the job: %q", e.Message)
	}
}

// TestAwaitJob_AWaitedDeployPrintsItsWarnings: the narrated wait every waited deploy goes through
// ends with the deploy's warnings on stderr, and still returns success.
func TestAwaitJob_AWaitedDeployPrintsItsWarnings(t *testing.T) {
	p, out, errOut := famPrinter(ui.FormatTable)
	job, err := awaitJob(context.Background(), famJobGetter{job: famJob("SUCCESS", "add-on loki did not sync")}, "j1",
		waitOptions{Progress: p})
	if err != nil || job == nil {
		t.Fatalf("a deploy with warnings must still succeed: %v", err)
	}
	if !strings.Contains(errOut.String(), "add-on loki did not sync") {
		t.Errorf("stderr does not carry the warning: %q", errOut)
	}
	if out.Len() != 0 {
		t.Errorf("the wait wrote on stdout: %q", out)
	}
}

// --- jobs list ---

// famJobPages serves GET /api/jobs out of a fixed history, newest first.
type famJobPages struct {
	total    int
	capAt    int
	capped   bool
	requests []string
}

func (f *famJobPages) GetJobs(status string, limit, offset int) (*api.JobsPage, error) {
	f.requests = append(f.requests, fmt.Sprintf("%s/%d/%d", status, limit, offset))
	if f.capAt > 0 && limit > f.capAt {
		limit = f.capAt
	}
	page := &api.JobsPage{Total: f.total, Limit: limit, Offset: offset}
	if f.capped {
		page.Page.Mode = api.PageModeCapped
	}
	for i := offset; i < f.total && i < offset+limit; i++ {
		page.Jobs = append(page.Jobs, api.ProvisionJob{ID: fmt.Sprintf("job-%d", i), JobType: "PLAN", Status: "SUCCESS"})
	}
	return page, nil
}

// TestJobsList_OnePageCarriesTheTotalAndSaysMoreFollow: the json of one page is enough for a
// caller to know there is more and where to ask for it.
func TestJobsList_OnePageCarriesTheTotalAndSaysMoreFollow(t *testing.T) {
	src := &famJobPages{total: 45}
	res, err := runJobsList(src, jobsListQuery{Limit: 20, Offset: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Jobs) != 20 || res.Jobs[0].ID != "job-20" {
		t.Errorf("served %d jobs from %q, want 20 from job-20", len(res.Jobs), res.Jobs[0].ID)
	}
	if res.Total != 45 || !res.TotalExact || res.Limit != 20 || res.Offset != 20 || !res.HasMore {
		t.Errorf("paging facts = %+v", res)
	}

	p, out, errOut := famPrinter(ui.FormatJSON)
	if err := res.print(p); err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatalf("not one json object: %v", err)
	}
	for _, key := range []string{"jobs", "total", "total_exact", "limit", "offset", "has_more"} {
		if _, ok := doc[key]; !ok {
			t.Errorf("the json has no %q key: %s", key, out)
		}
	}
	if errOut.Len() != 0 {
		t.Errorf("a json list wrote on stderr: %q", errOut)
	}
}

// TestJobsList_AllWalksEveryPage: --all returns the whole set, asks page by page, and ends on the
// short page rather than on a count.
func TestJobsList_AllWalksEveryPage(t *testing.T) {
	for name, src := range map[string]*famJobPages{
		"exact total":        {total: 45},
		"capped total":       {total: 45, capped: true},
		"server clamps size": {total: 45, capAt: 10},
		"a whole number":     {total: 40},
	} {
		t.Run(name, func(t *testing.T) {
			res, err := runJobsList(src, jobsListQuery{Limit: 20, All: true})
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Jobs) != src.total || res.HasMore {
				t.Errorf("got %d jobs, has_more %v — want all %d and no more", len(res.Jobs), res.HasMore, src.total)
			}
			seen := map[string]bool{}
			for _, j := range res.Jobs {
				if seen[j.ID] {
					t.Fatalf("job %s was returned twice", j.ID)
				}
				seen[j.ID] = true
			}
		})
	}
}

// TestJobsList_TheLastPageHasNoMore and an empty history is an empty array, never null.
func TestJobsList_TheLastPageHasNoMore(t *testing.T) {
	res, err := runJobsList(&famJobPages{total: 45}, jobsListQuery{Limit: 20, Offset: 40})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Jobs) != 5 || res.HasMore {
		t.Errorf("last page: %d jobs, has_more %v", len(res.Jobs), res.HasMore)
	}

	none, err := runJobsList(&famJobPages{}, jobsListQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	p, out, _ := famPrinter(ui.FormatJSON)
	if err := none.print(p); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"jobs": []`) {
		t.Errorf("an empty history must be an empty array:\n%s", out)
	}
}

// TestJobsList_TheTableSaysWhenItStopsShort: for a person, the rest of the set is named on stderr
// with the two flags that reach it; csv gets rows and no note.
func TestJobsList_TheTableSaysWhenItStopsShort(t *testing.T) {
	res, err := runJobsList(&famJobPages{total: 45, capped: true}, jobsListQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	p, out, errOut := famPrinter(ui.FormatTable)
	if err := res.print(p); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"more than 45", "--offset 20", "--all"} {
		if !strings.Contains(errOut.String(), want) {
			t.Errorf("stderr does not say %q: %q", want, errOut)
		}
	}
	if strings.Contains(out.String(), "--offset") {
		t.Errorf("the note reached stdout: %q", out)
	}

	p, out, errOut = famPrinter(ui.FormatCSV)
	if err := res.print(p); err != nil {
		t.Fatal(err)
	}
	if lines := strings.Count(strings.TrimSpace(out.String()), "\n"); lines != 20 || errOut.Len() != 0 {
		t.Errorf("csv: %d data rows, stderr %q — want 20 and nothing", lines, errOut)
	}
}

// TestJobsList_AFailedFetchKeepsItsClass: the error is wrapped, not flattened.
func TestJobsList_AFailedFetchKeepsItsClass(t *testing.T) {
	_, err := runJobsList(famFailingLister{&api.APIError{StatusCode: http.StatusForbidden, Message: "Forbidden"}},
		jobsListQuery{Limit: 20})
	if got := famExit(err); got != clierr.ExitForbidden {
		t.Errorf("exit = %d (%v), want %d", got, err, clierr.ExitForbidden)
	}
}

// famFailingLister refuses every list.
type famFailingLister struct{ err error }

func (f famFailingLister) GetJobs(string, int, int) (*api.JobsPage, error) { return nil, f.err }

// --- jobs cancel ---

// famCanceller records the cancels it was sent.
type famCanceller struct {
	sent []string
	err  error
}

func (c *famCanceller) CancelJob(id string) error {
	c.sent = append(c.sent, id)
	return c.err
}

// TestJobCancel_ReturnsTheMutationResult pins the shape, and that a dry run sends nothing.
func TestJobCancel_ReturnsTheMutationResult(t *testing.T) {
	c := &famCanceller{}
	res, err := runJobCancel(c, "j1", false)
	if err != nil {
		t.Fatal(err)
	}
	if res.ID != "j1" || res.Kind != "job" || res.Action != ResultUpdated || res.DryRun || res.Job != nil {
		t.Errorf("result = %+v", res)
	}
	p, out, _ := famPrinter(ui.FormatJSON)
	if err := p.Result(res, nil); err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "kind", "action", "job", "dry_run", "object"} {
		if _, ok := doc[key]; !ok {
			t.Errorf("the result has no %q key: %s", key, out)
		}
	}

	dry := &famCanceller{}
	res, err = runJobCancel(dry, "j1", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(dry.sent) != 0 {
		t.Errorf("a dry run cancelled %v", dry.sent)
	}
	if !res.DryRun || res.Action != ResultUnchanged || res.ID != "j1" {
		t.Errorf("dry-run result = %+v", res)
	}
}

// TestJobCancel_RefusalsOwnTheirExitCodes: a finished job is a conflict whichever status the
// control plane chose for it, and the other refusals keep their own class.
func TestJobCancel_RefusalsOwnTheirExitCodes(t *testing.T) {
	cases := map[int]int{
		http.StatusBadRequest:   clierr.ExitConflict,
		http.StatusConflict:     clierr.ExitConflict,
		http.StatusNotFound:     clierr.ExitNotFound,
		http.StatusForbidden:    clierr.ExitForbidden,
		http.StatusBadGateway:   clierr.ExitUnavailable,
		http.StatusUnauthorized: clierr.ExitAuth,
	}
	for status, want := range cases {
		_, err := runJobCancel(&famCanceller{err: &api.APIError{StatusCode: status, Message: "refused"}}, "j1", false)
		e := clierr.From(err)
		if e == nil || e.Exit != want {
			t.Errorf("status %d: got %+v, want exit %d", status, e, want)
			continue
		}
		if (want == clierr.ExitConflict || want == clierr.ExitNotFound) && e.Hint == "" {
			t.Errorf("status %d: a refusal a person can act on carries no hint", status)
		}
	}
}

// --- through the cobra tree: the refusal's exit code and its stream ---

// TestJobsFamily_RefusalsExitWithAUsageCodeOnStderr drives the real tree with prompting off: each
// command names what is missing, on stderr, with stdout empty and before any request.
func TestJobsFamily_RefusalsExitWithAUsageCodeOnStderr(t *testing.T) {
	cases := []struct {
		want string
		args []string
	}{
		{"no job id given", []string{"jobs", "get", "--no-input"}},
		{"no job id given", []string{"jobs", "logs", "--no-input"}},
		{"no job id given", []string{"jobs", "cancel", "--no-input", "--yes"}},
		{"not a job status", []string{"jobs", "get", "--latest", "--status", "DONE", "--no-input"}},
		{"pass a job id or --latest", []string{"jobs", "logs", "job-older", "--latest", "--no-input"}},
		{"invalid --status", []string{"jobs", "list", "--status", "DONE", "--no-input"}},
		{"--offset cannot be negative", []string{"jobs", "list", "--offset", "-1", "--no-input"}},
		{"--timeout bounds a follow", []string{"jobs", "logs", "job-older", "--timeout", "5m", "--no-input"}},
	}
	for _, tc := range cases {
		want, args := tc.want, tc.args
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			s, run := jobsCmdEnv(t)
			var code int
			out, diag := captureStreams(t, func() { code = run(args...) })
			if code != clierr.ExitUsage {
				t.Errorf("exit = %d, want %d\n%s", code, clierr.ExitUsage, diag)
			}
			if out != "" {
				t.Errorf("stdout is not empty on a refusal: %q", out)
			}
			if !strings.Contains(diag, want) {
				t.Errorf("stderr does not say %q: %q", want, diag)
			}
			if s.count() != 0 {
				t.Errorf("a refusal about the command line reached the network: %v", s.requests)
			}
		})
	}
}

// TestJobsFamily_JSONShapesThroughTheTree runs each read through the real tree under -o json and
// checks stdout is one document with the keys the docs promise, and stderr carries no part of it.
func TestJobsFamily_JSONShapesThroughTheTree(t *testing.T) {
	cases := []struct {
		args []string
		keys []string
	}{
		{[]string{"jobs", "list", "-o", "json", "--no-input"}, []string{"jobs", "total", "limit", "offset", "has_more"}},
		{[]string{"jobs", "get", "job-newest", "-o", "json", "--no-input"}, []string{"id", "status", "warnings"}},
		{[]string{"jobs", "logs", "job-newest", "-o", "json", "--no-input"}, []string{"job_id", "logs"}},
		{[]string{"jobs", "cancel", "job-newest", "--yes", "-o", "json", "--no-input"}, []string{"id", "kind", "action", "job", "dry_run", "object"}},
		{[]string{"jobs", "cancel", "--latest", "--dry-run", "-o", "json", "--no-input"}, []string{"id", "kind", "action", "job", "dry_run", "object"}},
	}
	famApplyMeta(t)
	for _, tc := range cases {
		t.Run(strings.Join(tc.args, " "), func(t *testing.T) {
			s, run := jobsCmdEnv(t)
			var code int
			out, diag := captureStreams(t, func() { code = run(tc.args...) })
			if code != 0 {
				t.Fatalf("exit %d\n%s", code, diag)
			}
			var doc map[string]json.RawMessage
			if err := json.Unmarshal([]byte(out), &doc); err != nil {
				t.Fatalf("stdout is not one json object: %v\n%s", err, out)
			}
			for _, key := range tc.keys {
				if _, ok := doc[key]; !ok {
					t.Errorf("no %q key in %s", key, out)
				}
			}
			dry := strings.Contains(strings.Join(tc.args, " "), "--dry-run")
			if dry && s.saw(http.MethodPost, "/api/cli/jobs/job-newest/cancel") {
				t.Error("a dry run sent the cancel")
			}
			if dry && string(doc["dry_run"]) != "true" {
				t.Errorf("dry_run = %s", doc["dry_run"])
			}
		})
	}
}

// TestJobsCancel_DryRunNeedsNoConfirmation: a dry run changes nothing, so it runs with prompting
// off and without --yes — and it says which job it resolved.
func TestJobsCancel_DryRunNeedsNoConfirmation(t *testing.T) {
	famApplyMeta(t)
	s, run := jobsCmdEnv(t)
	var code int
	out, diag := captureStreams(t, func() { code = run("jobs", "cancel", "--latest", "--dry-run", "--no-input") })
	if code != 0 {
		t.Fatalf("exit %d\n%s", code, diag)
	}
	if s.saw(http.MethodPost, "/api/cli/jobs/job-newest/cancel") {
		t.Error("a dry run sent the cancel")
	}
	if !strings.Contains(out, "would be cancelled") || !strings.Contains(diag, "Deploy") {
		t.Errorf("stdout %q stderr %q", out, diag)
	}
}

// --- the registry entries ---

// TestMetaJobs_EveryCommandHasARunnableExample holds the family's entries to what they claim: every
// runnable command has an example, and every example names a command that exists, uses only flags
// that command takes, and carries no placeholder a reader would have to fill in from elsewhere.
func TestMetaJobs_EveryCommandHasARunnableExample(t *testing.T) {
	famApplyMeta(t)
	checked := 0
	for _, m := range metaJobs {
		words := strings.Fields(m.Path)
		cmd, rest, err := rootCmd.Find(words[1:])
		if err != nil || len(rest) != 0 {
			t.Errorf("%s: no such command (%v)", m.Path, err)
			continue
		}
		if !cmd.Runnable() {
			continue
		}
		if len(m.Examples) == 0 {
			t.Errorf("%s has no example", m.Path)
		}
		for _, ex := range m.Examples {
			checked++
			if !strings.HasPrefix(ex.Cmd, m.Path) {
				t.Errorf("%s: example %q is for another command", m.Path, ex.Cmd)
			}
			if strings.ContainsAny(ex.Cmd, "<>") {
				t.Errorf("%s: example %q carries a placeholder", m.Path, ex.Cmd)
			}
			if ex.Note == "" {
				t.Errorf("%s: example %q does not say what it does", m.Path, ex.Cmd)
			}
			for _, word := range strings.Fields(strings.TrimPrefix(ex.Cmd, m.Path)) {
				switch {
				case strings.HasPrefix(word, "--"):
					name, _, _ := strings.Cut(strings.TrimPrefix(word, "--"), "=")
					if cmd.Flags().Lookup(name) == nil && cmd.InheritedFlags().Lookup(name) == nil {
						t.Errorf("%s: example %q uses --%s, which the command does not take", m.Path, ex.Cmd, name)
					}
				case len(word) == 2 && word[0] == '-' && word[1] != '-':
					short := word[1:]
					if cmd.Flags().ShorthandLookup(short) == nil && cmd.InheritedFlags().ShorthandLookup(short) == nil {
						t.Errorf("%s: example %q uses -%s, which the command does not take", m.Path, ex.Cmd, short)
					}
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("no example was checked — this test covered nothing")
	}
}

// TestMetaJobs_TheFactsMatchTheCommands pins the facts that were corrected from reading the
// bodies, so an entry cannot drift back to what the command's name suggests.
func TestMetaJobs_TheFactsMatchTheCommands(t *testing.T) {
	famApplyMeta(t)
	registry := commandRegistry()
	cancel, _ := registry.Lookup("alethia jobs cancel")
	if !cancel.Mutates || !cancel.Destructive || cancel.DryRun != cmdmeta.DryRunClient {
		t.Errorf("jobs cancel = %+v, want mutating, destructive and a client dry run", cancel)
	}
	if jobsCancelCmd.Flags().Lookup(cmdmeta.DryRunFlag) == nil {
		t.Error("jobs cancel declares a dry run and has no --dry-run flag")
	}
	if jobsCancelCmd.Flags().Lookup("yes") == nil {
		t.Error("jobs cancel is destructive and has no --yes flag")
	}
	// Both write to the CLI's own credential cache, which is state that outlives the command.
	for _, path := range []string{"alethia cluster kubeconfig", "alethia cluster token"} {
		m, _ := registry.Lookup(path)
		if !m.Mutates || m.Output != cmdmeta.OutputSecret || m.LongRunning {
			t.Errorf("%s = %+v, want a mutating secret that is not long-running", path, m)
		}
	}
	for _, path := range []string{
		"alethia jobs list", "alethia jobs get", "alethia jobs logs", "alethia cluster list",
		"alethia cluster get", "alethia verify receipt", "alethia verify show",
	} {
		m, _ := registry.Lookup(path)
		if m.Mutates || m.Destructive || !m.Idempotent {
			t.Errorf("%s = %+v, want a read", path, m)
		}
	}
}

// --- the arms a healthy control plane never takes ---

// famBrokenWriter refuses every write, as a closed pipe does.
type famBrokenWriter struct{}

func (famBrokenWriter) Write([]byte) (int, error) { return 0, errors.New("broken pipe") }

// TestJobLogs_ALostLastDrainIsSaidAndTheVerdictStands: when the job has ended and the final fetch
// fails, the lines are lost but the answer is not — the command says so and still reports the
// job's result.
func TestJobLogs_ALostLastDrainIsSaidAndTheVerdictStands(t *testing.T) {
	famFastLogPolls(t)
	src := &famLogSource{
		logs: []famLogAnswer{{chunks: []api.JobLog{famChunk(1, "done\n")}}, {err: errors.New("gone")}},
		jobs: []famJobAnswer{{job: famJob("SUCCESS")}},
	}
	p, out, errOut := famPrinter(ui.FormatTable)
	if err := runJobLogs(context.Background(), src, p, "j1", jobLogsOptions{Follow: true}); err != nil {
		t.Fatalf("a lost final drain must not change a successful job's verdict: %v", err)
	}
	if out.String() != "done\n" {
		t.Errorf("stdout = %q", out)
	}
	if !strings.Contains(errOut.String(), "last log lines could not be read") || !strings.Contains(errOut.String(), "alethia jobs logs j1") {
		t.Errorf("stderr does not say what was lost and how to get it: %q", errOut)
	}
}

// TestJobsFamily_AStdoutThatCannotBeWrittenIsAnError: a document that did not reach stdout is not
// a success, in each command that prints one.
func TestJobsFamily_AStdoutThatCannotBeWrittenIsAnError(t *testing.T) {
	famFastLogPolls(t)
	broken := func() *Printer {
		return &Printer{Out: famBrokenWriter{}, Err: &bytes.Buffer{}, Format: ui.FormatJSON}
	}

	src := &famLogSource{logs: []famLogAnswer{{}}, jobs: []famJobAnswer{{job: famJob("SUCCESS")}}}
	if err := runJobLogs(context.Background(), src, broken(), "j1", jobLogsOptions{Follow: true}); err == nil {
		t.Error("a followed log whose document could not be written reported success")
	}
	if err := runJobLogs(context.Background(), src, broken(), "j1", jobLogsOptions{}); err == nil {
		t.Error("a log whose document could not be written reported success")
	}

	view, err := runJobGet(famJobGetter{job: famJob("SUCCESS", "a warning")}, "j1")
	if err != nil {
		t.Fatal(err)
	}
	p := broken()
	if err := view.print(p); err == nil {
		t.Error("a job that could not be written reported success")
	}

	res, err := runJobsList(&famJobPages{total: 3}, jobsListQuery{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if err := res.print(broken()); err == nil {
		t.Error("a list that could not be written reported success")
	}
	for _, format := range []string{ui.FormatCSV, ui.FormatTable} {
		p := broken()
		p.Format = format
		if err := res.print(p); err == nil {
			t.Errorf("a %s list that could not be written reported success", format)
		}
	}
}

// famNilLister answers a list with no page at all.
type famNilLister struct{}

func (famNilLister) GetJobs(string, int, int) (*api.JobsPage, error) { return nil, nil }

// TestJobsList_NoPageIsAnEmptyList: a control plane that answers with nothing yields an empty
// result, not a nil dereference.
func TestJobsList_NoPageIsAnEmptyList(t *testing.T) {
	res, err := runJobsList(famNilLister{}, jobsListQuery{Limit: 20, All: true})
	if err != nil || res.Jobs == nil || len(res.Jobs) != 0 || res.HasMore {
		t.Errorf("got %+v, %v", res, err)
	}
}

// TestCommandContext_IsNeverNil: a command run outside Execute has no context of its own.
func TestCommandContext_IsNeverNil(t *testing.T) {
	if commandContext(&cobra.Command{}) == nil {
		t.Error("a command with no context yielded nil")
	}
	type key struct{}
	cmd := &cobra.Command{}
	cmd.SetContext(context.WithValue(context.Background(), key{}, "v"))
	if commandContext(cmd).Value(key{}) != "v" {
		t.Error("a command's own context was replaced")
	}
}
