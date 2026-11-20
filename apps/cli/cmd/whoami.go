// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/spf13/cobra"
)

var whoamiCmd = &cobra.Command{
	Use:   "whoami",
	Short: "Show the current user and active organization",
	Long: `Ask the control plane who you are signed in as: the authenticated user, the
active organization context, your role in it, the org's plan, and its default
runner. It also says where the credential it used came from and when it expires.
The credential itself is never printed.

Use 'alethia auth status' for the same credential facts without a request to the
control plane, and --output json for scripting.`,
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fail(asAuthRequired(err))
			return
		}
		var credential *credentialStatus
		if status, err := currentCredentialStatus(); err == nil {
			credential = &status
		}
		if err := renderWhoami(api.NewClient(token), printer.Out, outputFormat(cmd), credential); err != nil {
			fail(fmt.Errorf("failed to resolve identity: %w", err))
		}
	},
}

// whoamiResult is `whoami` as json: the identity the control plane resolved, and the credential the
// CLI resolved it with.
type whoamiResult struct {
	*api.WhoAmI
	// Credential is where the credential came from. It is absent when that was not resolved.
	Credential *credentialStatus `json:"credential,omitempty"`
}

// runWhoami fetches the resolved identity and renders it. json emits the whole
// object; table/csv render a Field/Value view.
func runWhoami(c apiClient, out io.Writer, format string) error {
	return renderWhoami(c, out, format, nil)
}

// renderWhoami is runWhoami with the credential facts added, when the caller resolved them.
func renderWhoami(c apiClient, out io.Writer, format string, credential *credentialStatus) error {
	me, err := c.Whoami()
	if err != nil {
		return err
	}
	rows := [][]string{
		{"User", me.User.Email},
	}
	if me.User.Name != "" {
		rows = append(rows, []string{"Name", me.User.Name})
	}
	if me.ActiveOrg != nil {
		rows = append(rows,
			[]string{"Organization", me.ActiveOrg.Name},
			[]string{"Slug", me.ActiveOrg.Slug},
			[]string{"Role", me.ActiveOrg.Role},
			[]string{"Plan", me.ActiveOrg.Plan},
		)
	} else {
		rows = append(rows, []string{"Organization", ui.SymbolDash})
	}
	if me.DefaultRunner != nil {
		rows = append(rows, []string{"Default runner", me.DefaultRunner.Name})
	}
	if credential != nil {
		rows = append(rows,
			[]string{"Credential", credential.StoredIn},
			[]string{"Expires", credential.expiryText()},
		)
	}

	return ui.RenderCard(out, format, "alethia · whoami", rows, whoamiResult{WhoAmI: me, Credential: credential})
}

// --- auth status ---

// credentialStatus is what the CLI can say about the credential in use without sending it anywhere
// and without printing it.
type credentialStatus struct {
	// User is the account a stored sign-in belongs to. It is empty for a supplied token, which
	// carries no account the CLI can read.
	User string `json:"user,omitempty"`
	// Origin is the control plane the credential is used for.
	Origin string `json:"origin"`
	// Source is "flag", "env", "keychain" or "file".
	Source string `json:"source"`
	// StoredIn says where the credential is kept, in words.
	StoredIn string `json:"stored_in"`
	// Path is the credentials file, when Source is "file".
	Path string `json:"path,omitempty"`
	// ExpiresAt is when the access token stops being accepted, or null when the token does not say,
	// as a service token does not.
	ExpiresAt *time.Time `json:"expires_at"`
	// RenewsAutomatically reports that the CLI renews the access token by itself when it expires.
	RenewsAutomatically bool `json:"renews_automatically"`
}

// expiryLayout is how an expiry is shown to a person.
const expiryLayout = "2006-01-02 15:04 MST"

// expiryText is the expiry as a person reads it.
func (s credentialStatus) expiryText() string {
	if s.ExpiresAt == nil {
		return "not stated by the token"
	}
	text := s.ExpiresAt.UTC().Format(expiryLayout)
	switch {
	case s.RenewsAutomatically:
		return text + " (renewed automatically)"
	case s.ExpiresAt.Before(time.Now()):
		return text + " (expired)"
	}
	return text
}

// currentCredentialStatus describes the credential the next command would send: which of the four
// sources it comes from, for which control plane, and when it expires. It reads the store and
// nothing else — no request is made and nothing is renewed.
func currentCredentialStatus() (credentialStatus, error) {
	status := credentialStatus{Origin: normalizeOrigin(WebOrigin())}

	token, source := suppliedToken()
	switch source {
	case credentialFromFlag:
		status.StoredIn = "the --token flag (not stored)"
	case credentialFromEnv:
		status.StoredIn = "the " + ServiceTokenEnv + " environment variable (not stored)"
	default:
		cred, from, err := loadStoredCredential()
		if err != nil {
			return credentialStatus{}, err
		}
		token, source = cred.AccessToken, from
		status.User = cred.UserEmail
		status.RenewsAutomatically = cred.RefreshToken != ""
		status.StoredIn = "the system keychain"
		if from == credentialFromFile {
			status.Path, _ = getCredentialsPath()
			status.StoredIn = "the owner-only file " + status.Path
		}
	}
	status.Source = string(source)

	if expires, ok := tokenExpiry(token); ok {
		at := expires.UTC()
		status.ExpiresAt = &at
	}
	return status, nil
}

var authCmd = &cobra.Command{
	Use:   "auth",
	Short: "Inspect the credential the CLI is using",
	Long: `Inspect the credential the CLI is using on this machine.

'alethia login' and 'alethia logout' create and remove a stored sign-in;
'alethia auth status' says which credential the next command would send.`,
}

var authStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show who you are signed in as, where the credential is stored and when it expires",
	Long: `Show the credential the next command would send, without sending it anywhere.

It reports the account a stored sign-in belongs to, the control plane it is for,
where it is kept — the --token flag, the ALETHIA_TOKEN environment variable, the
system keychain, or the owner-only credentials file — and when the access token
expires. The credential itself is never printed.

A credential is looked for in that order, so a supplied token always wins over a
stored sign-in. Nothing is renewed and no request is made; use 'alethia whoami' to
have the control plane confirm the identity. With no credential it exits 4.`,
	Args: cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		status, err := currentCredentialStatus()
		if err != nil {
			fail(asAuthRequired(err))
			return
		}
		if err := renderAuthStatus(printer.Out, outputFormat(cmd), status); err != nil {
			fail(err)
		}
	},
}

// renderAuthStatus writes the credential facts as a card, as json, or as Field/Value csv rows.
func renderAuthStatus(out io.Writer, format string, status credentialStatus) error {
	user := status.User
	if user == "" {
		user = "not stated by a supplied token (run alethia whoami)"
	}
	rows := [][]string{
		{"User", user},
		{"Control plane", status.Origin},
		{"Credential", status.StoredIn},
		{"Expires", status.expiryText()},
	}
	return ui.RenderCard(out, format, "alethia · auth status", rows, status)
}

func init() {
	rootCmd.AddCommand(whoamiCmd)
	authCmd.AddCommand(authStatusCmd)
	rootCmd.AddCommand(authCmd)
}
