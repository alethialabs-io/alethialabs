# Feature: Grape CLI UI Improvements (Auth & Core Commands)

## Objective
Enhance the user experience and visual design of the core Grape CLI commands (`login`, `logout`, and auth-restricted commands) using the `lipgloss` and `huh` libraries, without altering their underlying functionality.

## Plan

### 1. `logout` Command
- **Current:** Prints "Successfully logged out."
- **Improvement:** 
  - Use `lipgloss` to render a styled success message.
  - Add a styled hint: "If you want to log back in, run `grape login`."

### 2. Unauthenticated Command Execution
- **Current:** Prints "you are not logged in. Please run `grape login`" and exits.
- **Improvement:**
  - When an auth check fails in a command (e.g., `clusters list`), use `lipgloss` to show a clear, styled error message.
  - Instead of just exiting, use a `huh` confirmation prompt: "You need to be logged in to execute this command. Would you like to log in now?".
  - If "Yes", invoke the login flow directly.
  - If "No", exit gracefully.

### 3. `login` Command
- **Current:** Executes the OAuth device flow or browser login.
- **Improvement:**
  - Before starting the login flow, check a local configuration file (e.g., `~/.grape/preferences.json`).
  - If not suppressed, display a styled informative message: "To use the Grape CLI, you must have an account on the ADP ItGix Platform. You can register/sign in at: https://adp.prod.itgix.eu/auth/signin".
  - Provide a `huh` confirmation prompt: "Do not show this message again?". If "Yes", save this preference so it skips the message next time.
  - Proceed with the existing login flow.

## Tasks
- [ ] 1. Update `logout` command (`apps/grape/cmd/logout.go`).
- [ ] 2. Identify the auth middleware/check and update to use `huh` to prompt for login (`apps/grape/cmd/auth_utils.go` or similar).
- [ ] 3. Update `login` command (`apps/grape/cmd/login.go`) to show the one-time registration message and save the preference using `~/.grape/preferences.json`.
- [ ] 4. Test the flows.