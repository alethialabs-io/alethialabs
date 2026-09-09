// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
)

// ── `config get`'s unknown-key picker (#4449) ────────────────────────────────────────────────
//
// `alethia config get` took a key and had no way to be asked for one. Its key has a DEFAULT
// — every key — so the missing-key case is already answered and is deliberately left alone
// (authFormNoFieldSpec records that decision); what had no answer at all was a key the CLI
// does not have, which was a refusal the reader could only act on by retyping the command.
//
// Most assertions below drive resolveConfigGetKey rather than the cobra Run, because Run
// ends in fail() and os.Exit. The WIRING is therefore asserted on its own, through the
// command's Run, by the last arm here — without it every test in this file would still pass
// with the Run reading args[0] exactly as it did before.

// configGetAnsweredPicker stands in for a user who accepted what the picker offered, and
// reports whether it was opened at all.
//
// No stub can answer through the pointer the huh group owns, so what comes back is the
// pre-seeded first option — which is a real config key, and that is what makes the arm
// discriminating: a resolver that ignored the form would hand back the MISS it was given,
// and the miss is by construction not a config key.
func configGetAnsweredPicker(t *testing.T) *bool {
	t.Helper()
	opened := new(bool)
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		*opened = true
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })
	return opened
}

// A key the spec has is returned untouched and asks nothing: the picker exists for a MISS,
// and opening it on a hit would put a question in front of a command that had its answer.
func TestConfigGetForm_KnownKeyIsNotAskedAbout(t *testing.T) {
	authFormInteractive(t)
	authFormNoForm(t)
	for _, in := range []string{"web-origin", "WEB-ORIGIN", " active_org "} {
		got, err := resolveConfigGetKey(in)
		if err != nil {
			t.Fatalf("resolveConfigGetKey(%q): %v", in, err)
		}
		if got != in {
			t.Errorf("resolveConfigGetKey(%q) = %q — a known key must reach runConfigGet unchanged", in, got)
		}
	}
}

// The default is EVERY key, so neither spelling of "all of them" is a question. This is the
// arm that breaks if the form is ever hung on a MISSING argument instead of a wrong one.
func TestConfigGetForm_TheDefaultIsAnsweredNotAsked(t *testing.T) {
	authFormInteractive(t)
	authFormNoForm(t)
	for _, in := range []string{"", "all", "   ", "ALL"} {
		got, err := resolveConfigGetKey(in)
		if err != nil {
			t.Fatalf("resolveConfigGetKey(%q): %v", in, err)
		}
		if got != in {
			t.Errorf("resolveConfigGetKey(%q) = %q, want it unchanged", in, got)
		}
	}
}

// With prompting disabled the miss is refused in the words runConfigGet would have used, so
// a scripted caller sees exactly what it saw before — and the keys it may pass instead.
func TestConfigGetForm_ScriptedMissIsRefusedWithTheRealKeys(t *testing.T) {
	isolatedConfigHome(t)
	authFormScripted(t)
	authFormNoForm(t)
	got, err := resolveConfigGetKey("weborigin")
	if err == nil {
		t.Fatalf("a miss under --no-input returned %q instead of an error", got)
	}
	for _, f := range configFields {
		if !strings.Contains(err.Error(), f.Key) {
			t.Errorf("the refusal omits the real key %q: %v", f.Key, err)
		}
	}
	// Word for word what runConfigGet answers, so one condition cannot come to have two
	// refusals that drift apart.
	direct := runConfigGet(io.Discard, "", "weborigin")
	if direct == nil || direct.Error() != err.Error() {
		t.Errorf("the gated refusal is %q and runConfigGet's is %v — they must be one sentence", err, direct)
	}
}

// On a terminal the miss opens the picker instead of refusing.
func TestConfigGetForm_TerminalMissOffersThePicker(t *testing.T) {
	authFormInteractive(t)
	opened := configGetAnsweredPicker(t)
	got, err := resolveConfigGetKey("weborigin")
	if err != nil {
		t.Fatalf("resolveConfigGetKey: %v", err)
	}
	if !*opened {
		t.Fatal("a miss on a terminal was refused instead of asked about")
	}
	if lookupConfigField(got) == nil {
		t.Errorf("the picker returned %q, which is not a config key", got)
	}
}

// The picker offers EVERY key, and that is the difference between it and `config set`'s.
// promptConfigSet filters on settable() because a read-only key is nothing `set` can act on;
// `get` reads them all, and `active-org` — read-only — is one of the two values a person
// runs this command for. A filtered picker here would hide a key the refusal it replaces had
// just named as supported, which is the exact defect the shared spec was built to end.
func TestConfigGetForm_PickerOffersReadOnlyKeysToo(t *testing.T) {
	readOnly := []string{}
	for _, f := range configFields {
		if !f.settable() {
			readOnly = append(readOnly, f.Key)
		}
	}
	if len(readOnly) == 0 {
		t.Skip("no read-only key in the spec — the two pickers cannot be told apart")
	}
	offered := map[string]bool{}
	for _, o := range configGetKeyOptions() {
		offered[o.Value] = true
	}
	for _, f := range configFields {
		if !offered[f.Key] {
			t.Errorf("the `config get` picker omits %q", f.Key)
		}
	}
	for _, k := range readOnly {
		if !offered[k] {
			t.Errorf("the `config get` picker omits the read-only key %q — `get` reads it", k)
		}
	}
	if len(offered) != len(configFields) {
		t.Errorf("the picker offers %d options for %d keys", len(offered), len(configFields))
	}
}

// Each option is labelled with its own summary, so the picker answers "which one did you
// mean" with what each key IS rather than with a list of names the reader has already failed
// to spell.
func TestConfigGetForm_OptionsCarryTheirSummary(t *testing.T) {
	opts := configGetKeyOptions()
	if len(opts) == 0 {
		t.Fatal("the picker offers nothing — every assertion here would be vacuous")
	}
	// Indexed by VALUE rather than by position, so a picker that dropped an option reports
	// the key it dropped instead of running off the end of the slice.
	labels := map[string]string{}
	for _, o := range opts {
		labels[o.Value] = o.Key
	}
	for _, f := range configFields {
		label, offered := labels[f.Key]
		if !offered {
			t.Errorf("the picker offers no option for %q", f.Key)
			continue
		}
		if !strings.Contains(label, f.Summary) {
			t.Errorf("%q's option is %q and does not carry its summary", f.Key, label)
		}
	}
}

// An aborted picker is an error, not a key. A resolver that swallowed the abort would carry
// on with the pre-seeded first option — a perfectly plausible key nobody chose, whose value
// would then be printed as though it had been asked for.
func TestConfigGetForm_AbortedPickerIsPropagated(t *testing.T) {
	authFormInteractive(t)
	authArmFormError(t, errors.New("aborted"))
	got, err := resolveConfigGetKey("weborigin")
	if err == nil {
		t.Fatalf("an aborted picker returned %q instead of an error", got)
	}
	if got != "" {
		t.Errorf("an aborted picker still produced %q", got)
	}
}

// The empty-picker arm. Unreachable while the spec holds a key, which is exactly why it is
// worth driving: an empty box returns the empty string, and `config get ""` means "all of
// them" — so the miss would print a whole configuration and read as a success.
func TestConfigGetForm_WithNoKeysAtAllRefuses(t *testing.T) {
	authFormInteractive(t)
	authFormNoForm(t)
	prev := configFields
	configFields = nil
	t.Cleanup(func() { configFields = prev })

	got, err := resolveConfigGetKey("weborigin")
	if err == nil {
		t.Fatalf("an empty picker was opened and answered %q", got)
	}
	if got != "" {
		t.Errorf("the empty-spec arm produced %q", got)
	}
}

// The command is WIRED to the resolver: the key it settles on is the key that is read. Every
// other test in this file drives resolveConfigGetKey directly and would still pass with the
// Run reading args[0] as it did before this unit.
func TestConfigGetForm_TheResolvedKeyIsTheKeyThatIsRead(t *testing.T) {
	isolatedConfigHome(t)
	resetFlagsAroundTest(t)
	authFormInteractive(t)

	prevExit := exitFunc
	exitFunc = func(code int) { t.Errorf("the command exited %d instead of printing a value", code) }
	t.Cleanup(func() { exitFunc = prevExit })

	// The resolver answers a key the ARGUMENT is not, so a Run that still read args[0] would
	// print the web origin — or refuse — rather than the org name below.
	seen := ""
	prev := resolveConfigGetKey
	resolveConfigGetKey = func(k string) (string, error) { seen = k; return "active-org", nil }
	t.Cleanup(func() { resolveConfigGetKey = prev })

	cfg := types.LoadCliConfig()
	cfg.ActiveOrgName = "acme-from-the-picker"
	if err := types.SaveCliConfig(cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	out := configGetCaptureStdout(t, func() {
		execRootArgs([]string{"config", "get", "weborigin"})
		if err := rootCmd.Execute(); err != nil {
			t.Errorf("execute `config get weborigin`: %v", err)
		}
	})
	if seen != "weborigin" {
		t.Errorf("the resolver was handed %q, not the argument the user typed", seen)
	}
	if !strings.Contains(out, "acme-from-the-picker") {
		t.Errorf("`config get weborigin` printed %q — the resolved key never reached runConfigGet", out)
	}
}

// The resolver is not the only gate, and it must not become one. runConfigGet still refuses a
// key it cannot read — that arm also carries a render failure, which no resolver can see — so a
// resolver that let something through cannot make the command print an answer it does not have.
//
// Before this unit that refusal was reached by typing an unknown key; the picker now catches
// those first, and this drives what is left of the arm rather than letting it go quiet.
func TestConfigGetForm_RunConfigGetStillRefusesWhatItCannotRead(t *testing.T) {
	isolatedConfigHome(t)
	resetFlagsAroundTest(t)
	authFormScripted(t)

	exited := 0
	prevExit := exitFunc
	exitFunc = func(code int) { exited = code }
	t.Cleanup(func() { exitFunc = prevExit })

	prev := resolveConfigGetKey
	resolveConfigGetKey = func(string) (string, error) { return "bogus", nil }
	t.Cleanup(func() { resolveConfigGetKey = prev })

	execRootArgs([]string{"config", "get", "web-origin"})
	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if exited != 1 {
		t.Errorf("a key runConfigGet cannot read exited %d — it must still be refused", exited)
	}
}

// configGetCaptureStdout runs body with os.Stdout redirected to a pipe and returns what was
// written. The pipe is drained on a goroutine so a write larger than the buffer cannot
// deadlock the test.
func configGetCaptureStdout(t *testing.T, body func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	prev := os.Stdout
	os.Stdout = w
	done := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(r)
		done <- string(b)
	}()
	// Restored through Cleanup as well as below, so a body that fails the test cannot leave
	// the rest of the package writing into a pipe nobody is reading.
	t.Cleanup(func() { os.Stdout = prev })
	body()
	os.Stdout = prev
	if err := w.Close(); err != nil {
		t.Fatalf("close pipe: %v", err)
	}
	return <-done
}
