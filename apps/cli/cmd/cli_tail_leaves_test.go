// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/spf13/pflag"
)

// The last two leaves the CLI-surface census reported as "takes input with no form" (#3663):
// `alethia login` and `alethia project component kinds`. They were closed two different ways, and
// each test below pins the way its leaf was closed.
//
//   - login gained a question: `--force`, asked only when a session already exists.
//   - kinds gained nothing. It never used the --project/--env it inherited from its group, so the
//     flags moved onto the verbs that read them and kinds stopped taking input at all.
//
// Every identifier here carries the tailLeaves prefix.

// tailLeavesSignedIn stores a live session for email and returns the credentials path.
func tailLeavesSignedIn(t *testing.T, email string) string {
	t.Helper()
	credsPath := isolatedHome(t)
	// The first-run notice opens a confirm of its own; hiding it keeps each test to one form.
	savePreferences(cliPreferences{HideLoginWarning: true})
	if err := saveCredentials(credsPath, types.ExchangeResponse{
		AccessToken: makeToken(t, time.Now().Add(time.Hour)), RefreshToken: "r", UserEmail: email,
	}); err != nil {
		t.Fatal(err)
	}
	return credsPath
}

// tailLeavesStoredEmail reads back which account the stored session belongs to.
func tailLeavesStoredEmail(t *testing.T, credsPath string) string {
	t.Helper()
	data, err := os.ReadFile(credsPath)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// TestTailLeaves_LoginAsksAndSignsInAgain drives the real Select one press down — "Sign in again" —
// and asserts the stored session now belongs to the account the device flow returned. A nil form
// stub would leave the answer at its seed ("Keep"), so this can only pass through the widget.
func TestTailLeaves_LoginAsksAndSignsInAgain(t *testing.T) {
	credsPath := tailLeavesSignedIn(t, "old@x.com")
	authCovServer(t, authCovExchange("new@x.com"))
	authCovHeadless(t)
	authCovTTY(t)
	scripts := authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyDown, tea.KeyEnter)})

	if err := authCovRunCLI(t, "login"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("login with a stored session on a terminal must ask whether to sign in again")
	}
	if got := tailLeavesStoredEmail(t, credsPath); !strings.Contains(got, "new@x.com") {
		t.Errorf("choosing \"Sign in again\" must re-run the device flow; stored session is %s", got)
	}
}

// TestTailLeaves_LoginKeepIsTheDefault pins that pressing enter keeps the session and never reaches
// the control plane: the first option is "Keep", so the question costs nothing to dismiss.
func TestTailLeaves_LoginKeepIsTheDefault(t *testing.T) {
	credsPath := tailLeavesSignedIn(t, "old@x.com")
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("keeping the session must not call the control plane (%s)", r.URL.Path)
	})
	authCovHeadless(t)
	authCovTTY(t)
	scripts := authFormAnswer(t, &authFormScript{keys: authFormKey(nil, tea.KeyEnter)})

	if err := authCovRunCLI(t, "login"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if !scripts[0].ran {
		t.Fatal("the question was never asked")
	}
	if got := tailLeavesStoredEmail(t, credsPath); !strings.Contains(got, "old@x.com") {
		t.Errorf("keeping the session must leave it untouched; stored session is %s", got)
	}
}

// TestTailLeaves_LoginFormErrorIsFatal pins that an aborted or broken question exits non-zero
// rather than being read as either answer.
func TestTailLeaves_LoginFormErrorIsFatal(t *testing.T) {
	tailLeavesSignedIn(t, "old@x.com")
	authCovTrapExit(t)
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a failed question must not start a sign-in (%s)", r.URL.Path)
	})
	authCovHeadless(t)
	authCovTTY(t)
	authCovForm(t, huh.ErrUserAborted)

	authCovWantExit(t, "login with an aborted question", func() {
		_ = authCovRunCLI(t, "login")
	})
}

// TestTailLeaves_LoginHeadlessNeverAsks pins the headless contract: under --no-input no form opens
// and the answer is "keep", which is what login did before the question existed.
func TestTailLeaves_LoginHeadlessNeverAsks(t *testing.T) {
	tailLeavesSignedIn(t, "old@x.com")
	authCovServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("a headless login with a session must not call the control plane (%s)", r.URL.Path)
	})
	authCovHeadless(t)
	authCovTTY(t)
	prev := runHuhForm
	runHuhForm = func(...*huh.Group) error {
		t.Error("--no-input must never open a form")
		return nil
	}
	t.Cleanup(func() { runHuhForm = prev })

	if err := authCovRunCLI(t, "login", "--no-input"); err != nil {
		t.Fatalf("login --no-input: %v", err)
	}
	again, err := askLoginAgain("old@x.com")
	if err != nil || again {
		t.Errorf("askLoginAgain with prompting disabled = (%v, %v), want (false, nil)", again, err)
	}
}

// TestTailLeaves_ComponentScopeFlagsLiveOnTheVerbsThatReadThem pins where --project and --env are
// registered: on list, add and remove, and NOT on kinds, which reads neither. kinds is checked for
// INHERITED flags as well as its own, so a flag re-added persistently on the group fails it too.
func TestTailLeaves_ComponentScopeFlagsLiveOnTheVerbsThatReadThem(t *testing.T) {
	has := func(fs *pflag.FlagSet, name string) bool { return fs.Lookup(name) != nil }
	for _, c := range []struct {
		name  string
		flags *pflag.FlagSet
	}{
		{"list", projectComponentListCmd.Flags()},
		{"add", projectComponentAddCmd.Flags()},
		{"remove", projectComponentRemoveCmd.Flags()},
	} {
		for _, f := range []string{"project", "env"} {
			if !has(c.flags, f) {
				t.Errorf("`project component %s` has no --%s", c.name, f)
			}
		}
	}
	for _, f := range []string{"project", "env"} {
		if has(projectComponentKindsCmd.Flags(), f) || has(projectComponentKindsCmd.InheritedFlags(), f) {
			t.Errorf("`project component kinds` accepts --%s, which it never reads", f)
		}
	}
}
