// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/clierr"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/api"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/google/uuid"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

// --- Preferences for UI ---

// cliPreferences is what the CLI remembers about how this person uses it. Nothing in it is secret.
type cliPreferences struct {
	// HideLoginWarning records that a sign-in has succeeded on this machine, so the line that
	// points a newcomer at the registration page is not shown again.
	HideLoginWarning bool `json:"hide_login_warning"`
}

// The device-login flow talks to three things a test cannot have: a TTY, a desktop
// browser, and a control plane. These four variables are the seams that let the flow
// run headlessly. Each default is exactly the call it replaced, so production
// behaviour is unchanged.
var (
	// authRequiredPrompt asks whether to log in now (opens a TTY form).
	authRequiredPrompt = ui.AuthRequiredPrompt
	// openBrowser launches the system browser at the device-login URL.
	openBrowser = browser.OpenURL
	// loginProgramOptions is nil in production, so tea.NewProgram is called exactly as
	// before; tests pass WithInput(nil)/WithOutput to keep the program off the terminal.
	loginProgramOptions []tea.ProgramOption
	// loginPollInterval is how long pollForToken waits between "pending" (404) polls.
	loginPollInterval = 2 * time.Second
	// loginPollThrottleInterval is the back-off pollForToken uses when the control plane
	// answers 429. A throttle is not a rejection, so the poll keeps waiting — just slower.
	loginPollThrottleInterval = 10 * time.Second
	// loginPollTimeout bounds the WHOLE device-flow poll. req's SetTimeout is a PER-REQUEST
	// timeout, so without a deadline the 404="pending" arm retries forever whenever the
	// browser half is never completed — a headless CI box, a broken browser.OpenURL, a
	// closed tab — and `alethia login` has to be killed.
	loginPollTimeout = 10 * time.Minute
	// loginRequestTimeout bounds a single exchange request.
	loginRequestTimeout = 120 * time.Second
	// loginStartTimeout bounds the one registration call. Short on purpose: registration
	// is best-effort and the login continues without it, so a control plane that is slow
	// to answer must not hold the user at a blank terminal before the URL is even printed.
	loginStartTimeout = 15 * time.Second
)

// deviceAccessDenied is RFC 8628 §3.5's terminal error code for a request the user
// refused. It is a WIRE value shared with the console — `DEVICE_ACCESS_DENIED` in
// apps/console/lib/auth/cli-device-code.ts writes it and this compares against it.
// Spelt differently on either side, the poll falls through to its generic
// "authentication failed (HTTP 403)" arm and the user is told nothing about why.
const deviceAccessDenied = "access_denied"

// deviceClientName is what this client calls itself when registering a login request.
// The console shows it on the consent screen as a CLAIM about who is asking, so it is a
// plain product name rather than anything the reader could mistake for an assertion the
// control plane is making.
const deviceClientName = "alethia-cli"

// deviceUserAgent describes this build to the control plane, which stores it and renders
// it on the consent screen. The OS/arch pair is the part that does work: "the terminal on
// this laptop" and "a device on another continent" look identical without it, and RFC
// 8628's threat model is a phished link.
func deviceUserAgent() string {
	v := version.Version
	if v == "" {
		v = "dev"
	}
	return fmt.Sprintf("%s/%s (%s; %s)", deviceClientName, v, runtime.GOOS, runtime.GOARCH)
}

// registerDeviceRequest tells the control plane about this login BEFORE the browser opens.
//
// Two things did not exist until it did. The user_code was minted here, printed here and
// put in the link, and the console only ever checked its SHAPE — so the code on the consent
// screen carried no server-verified meaning and could not be compared against anything.
// And nothing was known about the requester, so the screen could say no more than "A device
// is asking to sign in to your account" while approval hands over an access token, a 90-day
// refresh token and the raw OAuth token of the first linked git provider.
//
// The caller treats a failure as a WARNING, not a stop: a new CLI must still be able to log
// in to a control plane that predates this route. What is lost when it fails is the detail
// on the consent screen, not the ability to sign in — so the failure is reported and the
// flow continues.
func registerDeviceRequest(startURL, deviceCode, userCode string) error {
	var errMsg struct {
		Error string `json:"error"`
	}
	resp, err := req.C().SetTimeout(loginStartTimeout).R().
		SetHeader("User-Agent", deviceUserAgent()).
		SetBody(map[string]string{
			"device_code":    deviceCode,
			"user_code":      userCode,
			"client_name":    deviceClientName,
			"client_version": version.Version,
		}).
		SetErrorResult(&errMsg).
		Post(startURL)
	if err != nil {
		return fmt.Errorf("could not reach the control plane: %w", err)
	}
	if resp.IsErrorState() {
		return fmt.Errorf("control plane returned %d: %s", resp.StatusCode, errMsg.Error)
	}
	return nil
}

// resolveLogin handles the "not authenticated" branch of getAuthTokenInternal:
// it errors fast when prompting is disabled or when the confirm has no terminal to
// draw on, otherwise offers an interactive "log in now?" prompt, runs the device
// flow, and returns the fresh token. This is irreducible interactive glue, kept out
// of the unit-tested token-state logic.
func resolveLogin(_ string, promptLogin bool) (string, error) {
	if !promptLogin {
		return "", errNotSignedIn
	}

	// A confirm that cannot be SEEN cannot be answered. getAuthToken hardcodes
	// promptLogin=true, so before this gate the "log in now?" form was the one huh widget
	// in the CLI with no stream check at all: with stdin a terminal and the form's stream
	// redirected — `alethia … 2> log` — the ANSI frames went into the log and the process
	// then blocked on a keystroke against a terminal showing nothing. The user sees a hang.
	//
	// requireInteractiveForm is the refusing predicate the rest of the package already
	// uses before opening a form, and its errors say WHICH condition failed (errNoInput
	// for --no-input, errNoTTY for a redirected stream) — so wrap rather than replace,
	// while saying the same thing the promptLogin=false arm above says.
	if err := requireInteractiveForm(); err != nil {
		return "", fmt.Errorf("%w: %w", errNotSignedIn, err)
	}

	confirmLogin, err := authRequiredPrompt()
	if err != nil || !confirmLogin {
		return "", errNotSignedIn
	}

	session, err := signInAndSay()
	if err != nil {
		return "", err
	}
	// The credential was issued a moment ago, so it is returned as it is; and it is in the store
	// now, so it can be renewed when it came with the means to.
	if session.renewable {
		api.SetTokenRefresher(renewStoredCredential)
	}
	return session.accessToken, nil
}

func getPreferencesPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "alethia", "preferences.json"), nil
}

func loadPreferences() cliPreferences {
	var prefs cliPreferences
	path, err := getPreferencesPath()
	if err == nil {
		data, err := os.ReadFile(path)
		if err == nil {
			_ = json.Unmarshal(data, &prefs)
		}
	}
	return prefs
}

// savePreferences writes prefs for the owner alone. It is best-effort: a preference that cannot be
// saved costs a repeated hint, never a failed command.
func savePreferences(prefs cliPreferences) {
	path, err := getPreferencesPath()
	if err == nil {
		_ = ensureConfigDir(filepath.Dir(path))
		data, _ := json.MarshalIndent(prefs, "", "  ")
		_ = os.WriteFile(path, data, credentialsFileMode)
		// WriteFile applies the mode only to a file it creates; tighten one an older CLI left wider.
		_ = os.Chmod(path, credentialsFileMode)
	}
}

// --- Bubble Tea Model ---

// model is the spinner shown while the browser half of the sign-in is pending. It records how the
// wait ended and prints nothing about it: the command reports the result, on the stream a result
// belongs on.
type model struct {
	spinner   spinner.Model
	loading   bool
	done      bool
	err       error
	userEmail string
	// response is the control plane's answer to an approved sign-in.
	response *types.ExchangeResponse
}

func initialModel() model {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = ui.SpinnerStyle
	return model{
		spinner: s,
		loading: true,
	}
}

func (m model) Init() tea.Cmd {
	return m.spinner.Tick
}

type authSuccessMsg struct{ response *types.ExchangeResponse }
type authErrorMsg struct{ err error }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.Type == tea.KeyCtrlC || msg.Type == tea.KeyEsc {
			return m, tea.Quit
		}
	case authSuccessMsg:
		m.loading = false
		m.done = true
		m.userEmail = msg.response.UserEmail
		m.response = msg.response
		return m, tea.Quit
	case authErrorMsg:
		m.loading = false
		m.err = msg.err
		return m, tea.Quit
	default:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m model) View() string {
	if m.loading {
		return fmt.Sprintf("%s Waiting for authentication in the browser...", m.spinner.View())
	}
	return ""
}

// --- Polling and Token Handling ---

// exchangeDeviceCode polls the exchange endpoint until the browser half of the device flow is
// approved, the control plane returns a terminal status, or loginPollTimeout elapses. The
// client timeout is per-request; the deadline below is the overall budget.
func exchangeDeviceCode(deviceCode, exchangeURL string) (*types.ExchangeResponse, error) {
	client := req.C().SetTimeout(loginRequestTimeout) // Per-request timeout
	deadline := time.Now().Add(loginPollTimeout)
	for {
		var result types.ExchangeResponse
		var errMsg struct {
			Error       string `json:"error"`
			Description string `json:"error_description"`
		}
		resp, err := client.R().
			SetBody(map[string]string{"device_code": deviceCode}).
			SetSuccessResult(&result).
			SetErrorResult(&errMsg).
			Post(exchangeURL)

		if err != nil {
			return nil, clierr.Wrap(clierr.CodeNetworkUnreachable,
				fmt.Errorf("failed to connect to server: %w", err))
		}

		if resp.IsSuccessState() {
			return &result, nil
		}

		// Terminal, and the ONLY arm that reports a decision a person made. The refusal
		// used to reach nothing: "This isn't me" set browser-local state and the server
		// was never told, so this loop kept polling to its own ten-minute timeout and
		// the terminal — which in the phishing case is the ATTACKER's — learned nothing
		// either way. Matched on the RFC 8628 error code and not on the 403 alone, so an
		// unrelated forbidden still falls through to the generic arm below rather than
		// being reported to the user as a refusal that never happened.
		if resp.StatusCode == http.StatusForbidden && errMsg.Error == deviceAccessDenied {
			detail := errMsg.Description
			if detail == "" {
				detail = "The sign-in was refused in the browser."
			}
			return nil, clierr.New(clierr.CodeForbidden, fmt.Sprintf(
				"%s Nothing was shared and no token was issued (%s)",
				detail, deviceAccessDenied))
		}

		if resp.StatusCode == http.StatusGone {
			// Terminal: the device code expired or was already redeemed. Retrying can
			// never succeed, so say what happened instead of spinning.
			return nil, loginAgain(fmt.Sprintf(
				"this login code has expired or was already used — run `alethia login` again (HTTP 410): %s",
				errMsg.Error))
		}

		// 404 is our "pending" state and 429 means the control plane is throttling the
		// poll, not rejecting the login — both keep waiting, 429 with a longer back-off.
		// Any other status is fatal.
		wait := loginPollInterval
		if resp.StatusCode == http.StatusTooManyRequests {
			wait = loginPollThrottleInterval
		} else if resp.StatusCode != http.StatusNotFound {
			failure := fmt.Sprintf("authentication failed (HTTP %d): %s", resp.StatusCode, errMsg.Error)
			if resp.StatusCode >= http.StatusInternalServerError {
				return nil, clierr.New(clierr.CodeServiceUnavailable, failure)
			}
			return nil, loginAgain(failure)
		}

		if time.Until(deadline) <= wait {
			return nil, loginAgain(fmt.Sprintf(
				"timed out after %s waiting for the login to be approved in the browser", loginPollTimeout))
		}
		time.Sleep(wait)
	}
}

// pollForToken is exchangeDeviceCode as the message the spinner's program is sent when the wait ends.
func pollForToken(deviceCode, exchangeURL string) tea.Cmd {
	return func() tea.Msg {
		response, err := exchangeDeviceCode(deviceCode, exchangeURL)
		if err != nil {
			return authErrorMsg{err: err}
		}
		return authSuccessMsg{response: response}
	}
}

// loginAgain is a sign-in that did not complete and can simply be started again.
func loginAgain(message string) *clierr.Error {
	e := clierr.New(clierr.CodeAuthRequired, message)
	e.Hint = "alethia login"
	return e
}

// --- Login Flow Implementation ---

// sessionInfo is what a sign-in or a sign-out reports about the session it touched. It names the
// place a credential is kept and never the credential.
type sessionInfo struct {
	// User is the account the session belongs to.
	User string `json:"user"`
	// Origin is the control plane the session is for.
	Origin string `json:"origin"`
	// StoredIn is "keychain" or "file".
	StoredIn string `json:"stored_in"`
	// Path is the credentials file, when StoredIn is "file".
	Path string `json:"path,omitempty"`
}

// performLoginFlow signs in through the browser and stores the credential. It is the sign-in other
// commands run on the way to their own work, so what it says goes to stderr and their stdout stays
// their own.
func performLoginFlow() error {
	_, err := signInAndSay()
	return err
}

// signInAndSay signs in and names the account on stderr. It is the sign-in of every command but
// login itself, which reports the session as its own result.
func signInAndSay() (signedIn, error) {
	session, err := signIn()
	if err != nil {
		return signedIn{}, err
	}
	ui.SuccessTo(printer.Err, fmt.Sprintf("Signed in as %s.", session.User))
	return session, nil
}

// signedIn is a completed sign-in: the session to report, and the token to carry on with.
type signedIn struct {
	sessionInfo
	// accessToken is the access token the control plane issued.
	accessToken string
	// renewable reports that the credential came with a refresh token.
	renewable bool
}

// signIn runs the device-code flow against the current control plane, stores the credential it
// yields, says where it was stored, and returns the session.
//
// Everything it prints goes to stderr: the URL and the code are instructions to the person, not the
// command's result.
func signIn() (signedIn, error) {
	origin := WebOrigin()
	prefs := loadPreferences()
	if !prefs.HideLoginWarning {
		printer.Note(fmt.Sprintf("No account yet? Create one at %s/auth/signin", origin))
	}

	deviceCode := uuid.New().String()
	// RFC 8628 user_code: the browser shows the code it is about to approve and the user
	// compares it against this line. The alphabet is URL-safe, so it needs no escaping.
	userCode := newUserCode()
	loginURL := fmt.Sprintf("%s/cli/login?device_code=%s&user_code=%s", origin, deviceCode, userCode)
	exchangeURL := fmt.Sprintf("%s/api/auth/cli/exchange", origin)
	startURL := fmt.Sprintf("%s/api/auth/cli/start", origin)

	// Register BEFORE the URL is printed, so the consent screen the user is about to open
	// already has something to name. Best-effort: a control plane that predates this route
	// answers 404 and the login still works, it just shows less.
	//
	// The failure is REPORTED rather than swallowed. Silently degrading would leave the
	// user comparing a code and reading a requester line with no way to know that neither
	// was checked against anything.
	if err := registerDeviceRequest(startURL, deviceCode, userCode); err != nil {
		printer.Warn(fmt.Sprintf(
			"could not register this login with the control plane (%v). "+
				"The browser will show fewer details about this request.", err))
	}

	notice := printer.Err
	fmt.Fprintln(notice, ui.CyanStyle.Render("Please open the following URL in your browser to log in:"))
	fmt.Fprintln(notice, loginURL)
	fmt.Fprintln(notice)
	fmt.Fprintln(notice, ui.TextStyle.Render("Approve the login only if the browser shows this code:"))
	fmt.Fprintln(notice, ui.CyanStyle.Render(userCode))

	if !loginNoBrowser {
		if err := openBrowser(loginURL); err != nil {
			printer.Note("Could not open a browser automatically. Open the URL above yourself.")
		}
	}

	response, err := awaitApproval(deviceCode, exchangeURL)
	if err != nil {
		return signedIn{}, err
	}
	if response.AccessToken == "" {
		return signedIn{}, loginAgain("the control plane approved the sign-in but returned no credential")
	}

	write, err := storeCredential(storedCredential{ExchangeResponse: *response, KeepInFile: loginInsecureStorage})
	if err != nil {
		return signedIn{}, err
	}
	reportCredentialWrite(write, "", true)

	if !prefs.HideLoginWarning {
		prefs.HideLoginWarning = true
		savePreferences(prefs)
	}
	return signedIn{
		sessionInfo: sessionInfo{
			User:     response.UserEmail,
			Origin:   normalizeOrigin(origin),
			StoredIn: string(write.Source),
			Path:     write.Path,
		},
		accessToken: response.AccessToken,
		renewable:   response.RefreshToken != "",
	}, nil
}

// errLoginInterrupted is a sign-in the person stopped before the browser half was approved.
var errLoginInterrupted = clierr.New(clierr.CodeInterrupted, "the sign-in was cancelled before it was approved")

// awaitApproval waits for the browser half of the sign-in and returns the control plane's answer.
//
// A person at a terminal gets a spinner, drawn on stderr. An agent, a pipeline or a redirected
// stdin gets one plain progress line instead: there is nobody to animate for, and the spinner's
// program would try to read keys from a terminal that is not there.
func awaitApproval(deviceCode, exchangeURL string) (*types.ExchangeResponse, error) {
	if printer.Mode.Agent || printer.Mode.NoInput {
		printer.Progress("Waiting for the sign-in to be approved in the browser")
		return exchangeDeviceCode(deviceCode, exchangeURL)
	}
	poll := pollForToken(deviceCode, exchangeURL)

	options := append([]tea.ProgramOption{tea.WithOutput(os.Stderr)}, loginProgramOptions...)
	p := tea.NewProgram(initialModel(), options...)
	go func() {
		// This is a bit of a hack to ensure the Bubble Tea UI has time to render before polling starts
		time.Sleep(100 * time.Millisecond)
		p.Send(poll())
	}()

	final, err := p.Run()
	if err != nil {
		return nil, fmt.Errorf("an error occurred during login: %w", err)
	}
	// The program was started with a model, so that is what it ends with.
	finished, _ := final.(model)
	switch {
	case finished.err != nil:
		return nil, finished.err
	case finished.response != nil:
		return finished.response, nil
	}
	return nil, errLoginInterrupted
}

// --- Cobra Command ---

var (
	forceLogin     bool
	loginWebOrigin string
	// loginNoBrowser leaves the browser closed: the URL is printed for the person to open, on this
	// machine or another.
	loginNoBrowser bool
	// loginInsecureStorage keeps the credential in the owner-only file even where a system keychain
	// is available.
	loginInsecureStorage bool
)

// sessionKind is the kind a sign-in and a sign-out name in their result.
const sessionKind = "session"

// sessionResult builds the result of a command that created, kept or removed a session.
func sessionResult(action ResultAction, info sessionInfo) MutationResult {
	return MutationResult{
		ID:     credentialAccount(info.Origin),
		Kind:   sessionKind,
		Action: action,
		Object: info,
	}
}

// errLoginWithSuppliedToken refuses a sign-in while a token is supplied directly: every command
// would go on using the supplied token, so the sign-in would change nothing the person can see.
func errLoginWithSuppliedToken(source credentialSource) *clierr.Error {
	name := ServiceTokenEnv
	if source == credentialFromFlag {
		name = "--token"
	}
	e := clierr.New(clierr.CodeConflict, fmt.Sprintf(
		"%s is set, and every command uses it ahead of a stored sign-in, so signing in would change nothing", name))
	e.Hint = fmt.Sprintf("remove %s, then run `alethia login`; `alethia auth status` shows the credential in use", name)
	return e
}

// runLogin is the body of `alethia login`: it keeps a session that is already there unless asked to
// replace it, and otherwise signs in. It returns the result and prints nothing on stdout.
func runLogin() (MutationResult, error) {
	if _, source := suppliedToken(); source != "" {
		return MutationResult{}, errLoginWithSuppliedToken(source)
	}

	if !forceLogin {
		if _, err := getAuthTokenInternal(false); err == nil {
			cred, source, _ := loadStoredCredential()
			printer.Note(fmt.Sprintf("You are already logged in as: %s", cred.UserEmail))
			again, err := askLoginAgain(cred.UserEmail)
			if err != nil {
				return MutationResult{}, err
			}
			if !again {
				if !promptsEnabled() {
					printer.Note("Use --force to log in again.")
				}
				info := sessionInfo{User: cred.UserEmail, Origin: normalizeOrigin(WebOrigin()), StoredIn: string(source)}
				if source == credentialFromFile {
					info.Path, _ = getCredentialsPath()
				}
				return sessionResult(ResultUnchanged, info), nil
			}
		}
	}

	session, err := signIn()
	if err != nil {
		return MutationResult{}, err
	}
	return sessionResult(ResultCreated, session.sessionInfo), nil
}

// `alethia login` asks ONE question, and only when there is something to decide.
//
// A first sign-in asks nothing: login works with zero input, and putting a form in front of the
// single most frequent command in the product would cost every user a keystroke to collect an
// answer that almost never changes. The control-plane URL stays flag-only here — it is a
// once-per-machine setting, `alethia init` is the guided form for it, and `--web-origin` below is
// the flag, so the contract stays complete either way.
//
// The question is `--force`'s, asked when a session ALREADY exists. That is the one moment login
// needs a decision from the person. On a terminal it offers the choice (askLoginAgain); with
// prompting disabled it keeps the session, says so, and exits 0, so a script's behaviour is
// unchanged.
var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Sign in to the control plane from the browser",
	Long: `Sign in to the Alethia control plane through the browser device-code flow.

Needs no input: it prints a URL and a code, opens the browser, and waits for you to
approve the code there. The URL, the code and every notice go to stderr; the result
goes to stdout, as a sentence or as json under --output json.

The credential is stored in the operating system's credential store (Keychain on
macOS, the Secret Service on Linux, Credential Manager on Windows). Where there is
none — a container, a CI runner, a Linux host with no desktop session — it is stored
in an owner-only file in the CLI's configuration directory, and login says which of
the two it used. --insecure-storage chooses the file. A credential is used only for
the control plane that issued it.

In a pipeline do not log in: set ALETHIA_TOKEN to a token from 'alethia token create'.
While ALETHIA_TOKEN or --token is set, login refuses, because every command would
keep using that token. Use 'alethia init' for the guided first-run setup, and
'alethia auth status' to see which credential is in use.`,
	Run: func(cmd *cobra.Command, args []string) {
		// Persist a control-plane URL passed for this login (self-host/dev). Its confirmation is a
		// notice, so it goes to stderr with the rest of them.
		if loginWebOrigin != "" {
			if err := runConfigSet(printer.Err, "web-origin", loginWebOrigin); err != nil {
				fail(err)
				return
			}
		}

		result, err := runLogin()
		if err != nil {
			fail(err)
			return
		}
		if err := printer.Result(result, func(w io.Writer) { printSession(w, result) }); err != nil {
			fail(err)
		}
	},
}

// printSession writes the one sentence a person reads for a sign-in result.
func printSession(w io.Writer, result MutationResult) {
	info, _ := result.Object.(sessionInfo)
	if result.Action == ResultUnchanged {
		ui.InfoTo(w, fmt.Sprintf("Signed in as %s. The session was kept.", info.User))
		return
	}
	ui.SuccessTo(w, fmt.Sprintf("Signed in as %s.", info.User))
}

// askLoginAgain is `--force` asked as a question: with a session already stored, it offers to keep
// it or to sign in again. It returns false without asking when prompting is disabled (--no-input, or
// no terminal) — the headless answer is "keep the session", the same one login gave before this
// question existed. "Keep" is the first option, so pressing enter changes nothing.
func askLoginAgain(email string) (bool, error) {
	if !promptsEnabled() {
		return false, nil
	}
	again := false
	if err := runHuhForm(huh.NewGroup(
		huh.NewSelect[bool]().
			Title(fmt.Sprintf("Signed in as %s. Sign in again?", email)).
			Description("Signing in again replaces the stored session — to switch accounts, for instance.").
			Options(
				huh.NewOption("Keep this session", false),
				huh.NewOption("Sign in again (same as --force)", true),
			).
			Value(&again),
	)); err != nil {
		return false, err
	}
	return again, nil
}

func init() {
	rootCmd.AddCommand(loginCmd)
	loginCmd.Flags().BoolVarP(&forceLogin, "force", "f", false, "Sign in again even when a session is already stored")
	loginCmd.Flags().StringVar(&loginWebOrigin, "web-origin", "", "Control-plane URL to use & persist (self-host/dev)")
	loginCmd.Flags().BoolVar(&loginNoBrowser, "no-browser", false, "Print the sign-in URL without opening a browser")
	loginCmd.Flags().BoolVar(&loginInsecureStorage, "insecure-storage", false,
		"Store the credential in an owner-only file instead of the system keychain")
}
