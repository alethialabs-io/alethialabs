// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/google/uuid"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

// --- Preferences for UI ---

type cliPreferences struct {
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
)

// resolveLogin handles the "not authenticated" branch of getAuthTokenInternal:
// it errors fast when prompting is disabled, otherwise offers an interactive
// "log in now?" prompt, runs the device flow, and returns the fresh token. This
// is irreducible interactive glue, kept out of the unit-tested token-state logic.
func resolveLogin(credsPath string, promptLogin bool) (string, error) {
	if !promptLogin {
		return "", fmt.Errorf("authentication required. Please run `alethia login`")
	}

	confirmLogin, err := authRequiredPrompt()
	if err != nil || !confirmLogin {
		return "", fmt.Errorf("authentication required. Please run `alethia login`")
	}

	if err := performLoginFlow(); err != nil {
		return "", err
	}

	// Read credentials again after successful login.
	file, err := os.ReadFile(credsPath)
	if err != nil {
		return "", fmt.Errorf("error reading credentials file after login: %w", err)
	}

	var creds types.ExchangeResponse
	if err := json.Unmarshal(file, &creds); err != nil {
		return "", fmt.Errorf("error parsing credentials file after login: %w", err)
	}

	return creds.AccessToken, nil
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

func savePreferences(prefs cliPreferences) {
	path, err := getPreferencesPath()
	if err == nil {
		_ = os.MkdirAll(filepath.Dir(path), 0755)
		data, _ := json.MarshalIndent(prefs, "", "  ")
		_ = os.WriteFile(path, data, 0644)
	}
}

// --- Bubble Tea Model ---

type model struct {
	spinner   spinner.Model
	loading   bool
	done      bool
	err       error
	userEmail string
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
		saveTokens(msg.response)
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
	if m.done {
		return ui.FormatSuccess(fmt.Sprintf("Welcome, %s! You are now authenticated.", m.userEmail)) + "\n"
	}
	if m.err != nil {
		return ui.FormatError(fmt.Sprintf("Error: %v", m.err)) + "\n"
	}
	return ""
}

// --- Polling and Token Handling ---

// pollForToken polls the exchange endpoint until the browser half of the device flow is
// approved, the control plane returns a terminal status, or loginPollTimeout elapses. The
// client timeout is per-request; the deadline below is the overall budget.
func pollForToken(deviceCode, exchangeURL string) tea.Cmd {
	return func() tea.Msg {
		client := req.C().SetTimeout(loginRequestTimeout) // Per-request timeout
		deadline := time.Now().Add(loginPollTimeout)
		for {
			var result types.ExchangeResponse
			var errMsg struct {
				Error string `json:"error"`
			}
			resp, err := client.R().
				SetBody(map[string]string{"device_code": deviceCode}).
				SetSuccessResult(&result).
				SetErrorResult(&errMsg).
				Post(exchangeURL)

			if err != nil {
				return authErrorMsg{err: fmt.Errorf("failed to connect to server: %w", err)}
			}

			if resp.IsSuccessState() {
				return authSuccessMsg{response: &result}
			}

			if resp.StatusCode == http.StatusGone {
				// Terminal: the device code expired or was already redeemed. Retrying can
				// never succeed, so say what happened instead of spinning.
				return authErrorMsg{err: fmt.Errorf(
					"this login code has expired or was already used — run `alethia login` again (HTTP 410): %s",
					errMsg.Error)}
			}

			// 404 is our "pending" state and 429 means the control plane is throttling the
			// poll, not rejecting the login — both keep waiting, 429 with a longer back-off.
			// Any other status is fatal.
			wait := loginPollInterval
			if resp.StatusCode == http.StatusTooManyRequests {
				wait = loginPollThrottleInterval
			} else if resp.StatusCode != http.StatusNotFound {
				return authErrorMsg{err: fmt.Errorf("authentication failed (HTTP %d): %s", resp.StatusCode, errMsg.Error)}
			}

			if time.Until(deadline) <= wait {
				return authErrorMsg{err: fmt.Errorf(
					"timed out after %s waiting for the login to be approved in the browser", loginPollTimeout)}
			}
			time.Sleep(wait)
		}
	}
}

func saveTokens(tokens *types.ExchangeResponse) {
	credsPath, err := getCredentialsPath()
	if err != nil {
		failf("Error getting credentials path: %v", err)
	}

	if err := os.MkdirAll(filepath.Dir(credsPath), 0755); err != nil {
		failf("Error creating config directory: %v", err)
	}

	// 0600: this file holds the live access token, the 90-day refresh token and the raw
	// git-provider OAuth token. os.Create would ask for 0666 and let the umask decide.
	file, err := os.OpenFile(credsPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, credentialsFileMode)
	if err != nil {
		failf("Error creating credentials file: %v", err)
	}
	defer file.Close()

	// O_CREATE applies the mode only to a file it actually creates; tighten an existing
	// credentials.json an older CLI left world-readable. Best-effort (see saveCredentials).
	_ = file.Chmod(credentialsFileMode)

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(tokens); err != nil {
		failf("Error writing tokens to file: %v", err)
	}
}

// --- Login Flow Implementation ---

func performLoginFlow() error {
	prefs := loadPreferences()

	if !prefs.HideLoginWarning {
		infoBox := lipgloss.NewStyle().Foreground(ui.InkPrimary).Border(lipgloss.RoundedBorder()).Padding(1, 2).BorderForeground(ui.InkMuted)

		msg := fmt.Sprintf("To use the Alethia CLI, you must have an account on the Alethia.\nIf you don't have one, register at:\n%s", ui.LinkStyle.Render(WebOrigin()+"/auth/signin"))
		fmt.Println(infoBox.Render(msg))
		fmt.Println()

		var hideWarning bool
		err := runHuhForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Hide this message in the future?").
					Value(&hideWarning),
			),
		)

		if err == nil && hideWarning {
			prefs.HideLoginWarning = true
			savePreferences(prefs)
		}
		fmt.Println()
	}

	deviceCode := uuid.New().String()
	// RFC 8628 user_code: the browser shows the code it is about to approve and the user
	// compares it against this line. Without it a phished /cli/login link binds the
	// victim's account to the attacker's device code with nothing to compare against.
	// The alphabet is URL-safe, so it needs no escaping.
	userCode := newUserCode()
	origin := WebOrigin()
	loginURL := fmt.Sprintf("%s/cli/login?device_code=%s&user_code=%s", origin, deviceCode, userCode)
	exchangeURL := fmt.Sprintf("%s/api/auth/cli/exchange", origin)

	fmt.Println(ui.CyanStyle.Render("Please open the following URL in your browser to log in:"))
	fmt.Println(loginURL)
	fmt.Println()
	fmt.Println(ui.TextStyle.Render("Approve the login only if the browser shows this code:"))
	fmt.Println(ui.CyanStyle.Render(userCode))

	if err := openBrowser(loginURL); err != nil {
		fmt.Printf("\nCould not open browser automatically. Please open the link manually.\n")
	}

	p := tea.NewProgram(initialModel(), loginProgramOptions...)
	go func() {
		// This is a bit of a hack to ensure the Bubble Tea UI has time to render before polling starts
		time.Sleep(100 * time.Millisecond)
		p.Send(pollForToken(deviceCode, exchangeURL)())
	}()

	if _, err := p.Run(); err != nil {
		return fmt.Errorf("an error occurred during login: %w", err)
	}
	return nil
}

// --- Cobra Command ---

var (
	forceLogin     bool
	loginWebOrigin string
)

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate with the platform",
	Run: func(cmd *cobra.Command, args []string) {
		// 0. Persist a control-plane URL passed for this login (self-host/dev).
		if loginWebOrigin != "" {
			if err := runConfigSet(os.Stdout, "web-origin", loginWebOrigin); err != nil {
				fail(err)
			}
		}

		// 1. Check if already authenticated (unless forced)
		if !forceLogin {
			if _, err := getAuthTokenInternal(false); err == nil {
				// We need to fetch the email for display purposes since getAuthToken returns only the token
				credsPath, _ := getCredentialsPath()
				file, _ := os.ReadFile(credsPath)
				var creds types.ExchangeResponse
				_ = json.Unmarshal(file, &creds)

				fmt.Println(ui.TextStyle.Render(fmt.Sprintf("You are already logged in as: %s", ui.CyanStyle.Render(creds.UserEmail))))
				fmt.Println(ui.TextStyle.Render("Use --force to log in again."))
				return
			}
		}

		// 2. Proceed with login flow
		if err := performLoginFlow(); err != nil {
			fail(err)
		}
	},
}

func init() {
	rootCmd.AddCommand(loginCmd)
	loginCmd.Flags().BoolVarP(&forceLogin, "force", "f", false, "Force re-authentication")
	loginCmd.Flags().StringVar(&loginWebOrigin, "web-origin", "", "Control-plane URL to use & persist (self-host/dev)")
}
