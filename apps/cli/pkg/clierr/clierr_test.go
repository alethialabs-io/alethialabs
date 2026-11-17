// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package clierr

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/spec"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
)

// exitRow is one way an error value arrives at the fatal path, and the contract it must get.
type exitRow struct {
	name      string
	err       error
	exit      int
	class     Class
	code      string
	retryable bool
}

// exitRows carries AT LEAST ONE ROW PER EXIT CODE, each built from the kind of value that really
// produces it. TestFrom_EveryExitCodeHasARow checks the "every" against the registry, so a class
// added to the table without a row here fails rather than going untested.
func exitRows() []exitRow {
	missing := &spec.MissingError{Command: "alethia runner register", Fields: []spec.Field{{Flag: "name"}}}
	return []exitRow{
		{"an error nothing classifies", errors.New("boom"), 1, ClassUnclassified, CodeInternal, false},
		{"501 is not retryable, so it is not 'unavailable'", &api.APIError{StatusCode: 501}, 1, ClassUnclassified, CodeInternal, false},
		{"a status no row names", &api.APIError{StatusCode: 418}, 1, ClassUnclassified, CodeInternal, false},

		{"401", &api.APIError{StatusCode: 401}, 4, ClassAuth, CodeAuthRequired, false},
		{"a server code for an expired credential", &api.APIError{StatusCode: 401, Code: CodeTokenExpired}, 4, ClassAuth, CodeTokenExpired, false},
		{"403", &api.APIError{StatusCode: 403}, 5, ClassForbidden, CodeForbidden, false},
		{"404", &api.APIError{StatusCode: 404}, 6, ClassNotFound, CodeNotFound, false},
		{"409", &api.APIError{StatusCode: 409}, 7, ClassConflict, CodeConflict, false},
		{"412", &api.APIError{StatusCode: 412}, 7, ClassConflict, CodeConflict, false},
		{"a server code that is more precise than its status", &api.APIError{StatusCode: 409, Code: CodeAlreadyExists}, 7, ClassConflict, CodeAlreadyExists, false},

		{"400", &api.APIError{StatusCode: 400}, 8, ClassUsage, CodeValidationFailed, false},
		{"422", &api.APIError{StatusCode: 422}, 8, ClassUsage, CodeValidationFailed, false},
		{"a flag cobra could not parse", Wrap(CodeInvalidFlag, errors.New("unknown flag: --nope")), 8, ClassUsage, CodeInvalidFlag, false},
		{"a command cobra could not resolve", Wrap(CodeInvalidUsage, errors.New(`unknown command "x"`)), 8, ClassUsage, CodeInvalidUsage, false},

		{"required values with nothing to ask", missing, 9, ClassInputRequired, CodeInputRequired, false},
		{"required values, wrapped by the caller", fmt.Errorf("register: %w", missing), 9, ClassInputRequired, CodeInputRequired, false},
		{"a destructive command without --yes", New(CodeConfirmationRequired, "pass --yes"), 9, ClassInputRequired, CodeConfirmationRequired, false},

		{"429", &api.APIError{StatusCode: 429, RetryAfter: 3 * time.Second}, 10, ClassLimited, CodeRateLimited, true},
		{"402", &api.APIError{StatusCode: 402}, 10, ClassLimited, CodePlanLimit, true},

		{"a request that got no answer", &api.TransportError{Err: errors.New("dial tcp: connection refused")}, 11, ClassUnavailable, CodeNetworkUnreachable, true},
		{"a client error from a verb that does not wrap it", &url.Error{Op: "Get", URL: "https://x", Err: errors.New("EOF")}, 11, ClassUnavailable, CodeNetworkUnreachable, true},
		{"500", &api.APIError{StatusCode: 500}, 11, ClassUnavailable, CodeServiceUnavailable, true},
		{"503", &api.APIError{StatusCode: 503}, 11, ClassUnavailable, CodeServiceUnavailable, true},
		{"408", &api.APIError{StatusCode: 408}, 11, ClassUnavailable, CodeServiceUnavailable, true},

		{"a wait that ran out", New(CodeWaitTimeout, "still running"), 12, ClassWaitTimeout, CodeWaitTimeout, false},
		{"a job that finished FAILED", New(CodeOperationFailed, "job failed"), 13, ClassOperationFailed, CodeOperationFailed, false},
		{"a control plane that wants a newer CLI", &api.APIError{StatusCode: 400, Code: CodeCLITooOld}, 14, ClassCLITooOld, CodeCLITooOld, false},
		{"an interrupt", New(CodeInterrupted, "interrupted"), 130, ClassInterrupted, CodeInterrupted, false},
	}
}

// TestFrom_ExitTable is the contract: each kind of error gets the exit code, class and code the
// table promises.
func TestFrom_ExitTable(t *testing.T) {
	for _, row := range exitRows() {
		t.Run(row.name, func(t *testing.T) {
			e := From(row.err)
			if e == nil {
				t.Fatal("From returned nil for a non-nil error")
			}
			if e.Exit != row.exit || e.Class != row.class || e.Code != row.code || e.Retryable != row.retryable {
				t.Errorf("got exit=%d class=%q code=%q retryable=%v, want exit=%d class=%q code=%q retryable=%v",
					e.Exit, e.Class, e.Code, e.Retryable, row.exit, row.class, row.code, row.retryable)
			}
			if e.Message != row.err.Error() {
				t.Errorf("message = %q, want the error's own text %q", e.Message, row.err.Error())
			}
		})
	}
}

// TestFrom_EveryExitCodeHasARow holds exitRows and the registry together in both directions: every
// exit code in the table is exercised, and no row expects a code the table does not have.
func TestFrom_EveryExitCodeHasARow(t *testing.T) {
	tested := map[int]bool{}
	for _, row := range exitRows() {
		tested[row.exit] = true
	}
	registered := map[int]bool{}
	for _, def := range Classes() {
		registered[def.Exit] = true
		if !tested[def.Exit] {
			t.Errorf("exit %d (%s) has no row in exitRows", def.Exit, def.Class)
		}
	}
	for exit := range tested {
		if !registered[exit] {
			t.Errorf("exitRows expects exit %d, which the registry does not define", exit)
		}
	}
}

// TestFrom_NilIsNil pins exit 0's row: no error, no Error.
func TestFrom_NilIsNil(t *testing.T) {
	if e := From(nil); e != nil {
		t.Errorf("From(nil) = %+v, want nil", e)
	}
}

// TestRegistry_CommandDefinedCodesStayFree is the reason the global classes start at 4. `plan` and
// `apply` exit 2 and 3 with their own meaning; a class given either number would make one exit code
// mean two things.
func TestRegistry_CommandDefinedCodesStayFree(t *testing.T) {
	seen := map[int]Class{}
	for _, def := range Classes() {
		if other, dup := seen[def.Exit]; dup {
			t.Errorf("exit %d is claimed by both %q and %q", def.Exit, other, def.Class)
		}
		seen[def.Exit] = def.Class
		if def.Class == ClassUnclassified {
			if def.Exit != ExitUnclassified {
				t.Errorf("the unclassified class exits %d, want %d", def.Exit, ExitUnclassified)
			}
			continue
		}
		if def.Exit < FirstGlobalExit {
			t.Errorf("class %q exits %d; 2 and 3 belong to plan/apply and global classes start at %d",
				def.Class, def.Exit, FirstGlobalExit)
		}
	}
}

// TestRegistry_ThePublishedNumbers pins each number to its meaning. The numbers are an interface
// scripts branch on, so changing one must fail a test that says so, not merely move a constant.
func TestRegistry_ThePublishedNumbers(t *testing.T) {
	want := map[Class]int{
		ClassUnclassified: 1, ClassAuth: 4, ClassForbidden: 5, ClassNotFound: 6, ClassConflict: 7,
		ClassUsage: 8, ClassInputRequired: 9, ClassLimited: 10, ClassUnavailable: 11,
		ClassWaitTimeout: 12, ClassOperationFailed: 13, ClassCLITooOld: 14, ClassInterrupted: 130,
	}
	got := Classes()
	if len(got) != len(want) {
		t.Fatalf("the table has %d classes, want %d", len(got), len(want))
	}
	for _, def := range got {
		if exit, ok := want[def.Class]; !ok || exit != def.Exit {
			t.Errorf("class %q exits %d, want %d", def.Class, def.Exit, exit)
		}
		if def.Summary == "" {
			t.Errorf("class %q has no summary for the docs table", def.Class)
		}
	}
}

// TestRegistry_CodesAreWellFormed checks what the generated errors page relies on: a code is
// unique, snake_case and described, it belongs to a class the table has, and every class has at
// least one code.
func TestRegistry_CodesAreWellFormed(t *testing.T) {
	snake := regexp.MustCompile(`^[a-z]+(_[a-z]+)*$`)
	classes := map[Class]int{}
	for _, def := range Classes() {
		classes[def.Class] = 0
	}
	seen := map[string]bool{}
	for _, def := range Codes() {
		if seen[def.Code] {
			t.Errorf("code %q is registered twice", def.Code)
		}
		seen[def.Code] = true
		if !snake.MatchString(def.Code) {
			t.Errorf("code %q is not snake_case", def.Code)
		}
		if def.Summary == "" {
			t.Errorf("code %q has no summary", def.Code)
		}
		if _, ok := classes[def.Class]; !ok {
			t.Errorf("code %q names class %q, which the exit table does not have", def.Code, def.Class)
			continue
		}
		classes[def.Class]++
	}
	for class, n := range classes {
		if n == 0 {
			t.Errorf("class %q has no code", class)
		}
	}
}

// TestRegistry_AccessorsReturnCopies keeps a caller from editing the table through what it was
// handed.
func TestRegistry_AccessorsReturnCopies(t *testing.T) {
	Classes()[0].Exit = 99
	Codes()[0].Code = "edited"
	if Classes()[0].Exit != ExitUnclassified || Codes()[0].Code != CodeInternal {
		t.Error("an accessor handed out the registry's own slice")
	}
}

// TestNew_AnUnregisteredCodeIsUnclassified pins the failure mode of a typo: the code is kept, and
// the exit is 1 rather than some other class's number.
func TestNew_AnUnregisteredCodeIsUnclassified(t *testing.T) {
	e := New("not_a_registered_code", "x")
	if e.Code != "not_a_registered_code" || e.Class != ClassUnclassified || e.Exit != ExitUnclassified {
		t.Errorf("got %+v", e)
	}
	if def := classDef("not_a_class"); def.Class != ClassUnclassified {
		t.Errorf("an unknown class resolved to %q", def.Class)
	}
}

// TestFrom_AnUnknownServerCodeIsKeptAndClassedByStatus is the forward-compatibility rule: a newer
// control plane can send a code this CLI has never heard of, and the CLI still exits with a
// documented number.
func TestFrom_AnUnknownServerCodeIsKeptAndClassedByStatus(t *testing.T) {
	e := From(&api.APIError{StatusCode: 404, Code: "cluster_not_found", Message: "No such cluster"})
	if e.Code != "cluster_not_found" || e.Class != ClassNotFound || e.Exit != ExitNotFound {
		t.Errorf("got code=%q class=%q exit=%d", e.Code, e.Class, e.Exit)
	}
}

// TestFrom_CarriesWhatTheControlPlaneSent checks every field of an APIError reaches the Error, and
// that a prefix added with %w is still in the message.
func TestFrom_CarriesWhatTheControlPlaneSent(t *testing.T) {
	apiErr := &api.APIError{
		StatusCode: 429, Message: "slow down", RetryAfter: 7 * time.Second,
		Hint: "wait", DocsURL: "https://example.test/e", RequestID: "req_1",
	}
	wrapped := fmt.Errorf("failed to get runners: %w", apiErr)
	e := From(wrapped)

	if e.Message != "failed to get runners: slow down (status 429)" {
		t.Errorf("message = %q", e.Message)
	}
	if e.Hint != "wait" || e.DocsURL != "https://example.test/e" || e.RequestID != "req_1" {
		t.Errorf("hint/docs/request = %q/%q/%q", e.Hint, e.DocsURL, e.RequestID)
	}
	if e.HTTPStatus != 429 || e.RetryAfter != 7*time.Second {
		t.Errorf("status/retry-after = %d/%v", e.HTTPStatus, e.RetryAfter)
	}
	var back *api.APIError
	if !errors.As(e, &back) || back != apiErr {
		t.Error("the APIError is no longer reachable through the Error")
	}
}

// TestFrom_ATypedErrorIsBelieved covers both shapes an already-classified error arrives in: bare,
// where it is returned as it is, and wrapped, where the class is kept and the message becomes the
// whole chain's — without editing the original, which may be a package-level sentinel.
func TestFrom_ATypedErrorIsBelieved(t *testing.T) {
	sentinel := New(CodeConfirmationRequired, "pass --yes")
	sentinel.Hint = "add --yes"

	if got := From(sentinel); got != sentinel {
		t.Error("a bare typed error was not returned as it is")
	}

	got := From(fmt.Errorf("destroy: %w", sentinel))
	if got == sentinel {
		t.Fatal("a wrapped typed error was returned as the sentinel itself")
	}
	if got.Message != "destroy: pass --yes" || got.Exit != ExitInputRequired || got.Hint != "add --yes" {
		t.Errorf("got %+v", got)
	}
	if sentinel.Message != "pass --yes" {
		t.Errorf("classifying a wrapped sentinel rewrote it: %q", sentinel.Message)
	}
}

// TestWrap_KeepsTheCauseReachable pins Error() and Unwrap().
func TestWrap_KeepsTheCauseReachable(t *testing.T) {
	cause := errors.New("unknown flag: --nope")
	e := Wrap(CodeInvalidFlag, cause)
	if e.Error() != "unknown flag: --nope" {
		t.Errorf("Error() = %q", e.Error())
	}
	if !errors.Is(e, cause) {
		t.Error("the cause is not reachable with errors.Is")
	}
}

// TestWriteHuman pins the human form byte for byte, with and without the optional lines, and that
// the caller's styles are applied to the lines they name.
func TestWriteHuman(t *testing.T) {
	var plain bytes.Buffer
	WriteHuman(&plain, New(CodeInternal, "boom"), "✗", Styles{})
	if plain.String() != "\n✗ boom\n" {
		t.Errorf("a bare error rendered as %q", plain.String())
	}

	e := New(CodeNotFound, `No cluster named "prod-eu".`)
	e.Hint = "alethia cluster list"
	e.DocsURL = "https://example.test/errors#not_found"
	e.RequestID = "req_01"
	var full bytes.Buffer
	WriteHuman(&full, e, "✗", Styles{
		Headline: func(s string) string { return "<" + s + ">" },
		Detail:   func(s string) string { return "[" + s + "]" },
	})
	want := "\n<✗ No cluster named \"prod-eu\".>\n" +
		"[  hint     alethia cluster list]\n" +
		"[  docs     https://example.test/errors#not_found]\n" +
		"[  request  req_01]\n"
	if full.String() != want {
		t.Errorf("got:\n%q\nwant:\n%q", full.String(), want)
	}
}

// TestWriteJSON_Envelope pins the alethia.error/v1 envelope: one line, every key present, and null
// for what the error does not carry.
func TestWriteJSON_Envelope(t *testing.T) {
	var bare bytes.Buffer
	if err := WriteJSON(&bare, New(CodeInternal, "boom")); err != nil {
		t.Fatal(err)
	}
	wantBare := `{"error":{"code":"internal","class":"unclassified","exit_code":1,"message":"boom",` +
		`"hint":null,"docs_url":null,"retryable":false,"retry_after_seconds":null,"request_id":null,` +
		`"http_status":null,"operation":null},"schema":"alethia.error/v1"}` + "\n"
	if bare.String() != wantBare {
		t.Errorf("got:\n%s\nwant:\n%s", bare.String(), wantBare)
	}

	e := From(&api.APIError{
		StatusCode: 429, Message: "slow down", RetryAfter: 1500 * time.Millisecond,
		Hint: "wait", DocsURL: "https://example.test/e", RequestID: "req_1",
	})
	e.Operation = &Op{ID: "job_1", Type: "DEPLOY"}
	var full bytes.Buffer
	if err := WriteJSON(&full, e); err != nil {
		t.Fatal(err)
	}
	if strings.Count(full.String(), "\n") != 1 || !strings.HasSuffix(full.String(), "\n") {
		t.Errorf("the envelope is not exactly one line: %q", full.String())
	}
	var doc struct {
		Error struct {
			Code              string   `json:"code"`
			Class             string   `json:"class"`
			ExitCode          int      `json:"exit_code"`
			Hint              *string  `json:"hint"`
			DocsURL           *string  `json:"docs_url"`
			Retryable         bool     `json:"retryable"`
			RetryAfterSeconds *float64 `json:"retry_after_seconds"`
			RequestID         *string  `json:"request_id"`
			HTTPStatus        *int     `json:"http_status"`
			Operation         *Op      `json:"operation"`
		} `json:"error"`
		Schema string `json:"schema"`
	}
	if err := json.Unmarshal(full.Bytes(), &doc); err != nil {
		t.Fatalf("the envelope is not JSON: %v", err)
	}
	got := doc.Error
	if doc.Schema != Schema || got.Code != CodeRateLimited || got.Class != string(ClassLimited) ||
		got.ExitCode != ExitLimited || !got.Retryable {
		t.Errorf("got %+v schema=%q", got, doc.Schema)
	}
	if got.Hint == nil || *got.Hint != "wait" || got.DocsURL == nil || got.RequestID == nil || *got.RequestID != "req_1" {
		t.Errorf("hint/docs/request were not carried: %+v", got)
	}
	if got.RetryAfterSeconds == nil || *got.RetryAfterSeconds != 1.5 {
		t.Errorf("retry_after_seconds = %v, want 1.5", got.RetryAfterSeconds)
	}
	if got.HTTPStatus == nil || *got.HTTPStatus != 429 {
		t.Errorf("http_status = %v, want 429", got.HTTPStatus)
	}
	if got.Operation == nil || got.Operation.ID != "job_1" || got.Operation.Type != "DEPLOY" {
		t.Errorf("operation = %+v", got.Operation)
	}
}
