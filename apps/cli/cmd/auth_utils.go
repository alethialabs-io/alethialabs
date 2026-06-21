// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/charmbracelet/huh"
	"github.com/golang-jwt/jwt/v5"
	"github.com/imroc/req/v3"
)

func getCredentialsPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "alethia", "credentials.json"), nil
}

func getAuthToken() (string, error) {
	return getAuthTokenInternal(true)
}

func getAuthTokenInternal(promptLogin bool) (string, error) {
	credsPath, err := getCredentialsPath()
	if err != nil {
		return "", fmt.Errorf("error getting credentials path: %w", err)
	}

	needsLogin := false

	if _, err := os.Stat(credsPath); os.IsNotExist(err) {
		needsLogin = true
	} else {
		file, err := os.ReadFile(credsPath)
		if err != nil {
			return "", fmt.Errorf("error reading credentials file: %w", err)
		}

		var creds types.ExchangeResponse
		if err := json.Unmarshal(file, &creds); err != nil {
			needsLogin = true
		} else if creds.AccessToken == "" {
			needsLogin = true
		} else {
			// Check expiration
			claims := jwt.MapClaims{}
			_, _, err = jwt.NewParser().ParseUnverified(creds.AccessToken, claims)
			if err != nil {
				needsLogin = true
			} else {
				var exp int64
				switch v := claims["exp"].(type) {
				case float64:
					exp = int64(v)
				case json.Number:
					exp, _ = v.Int64()
				}

				// If expired (or expiring in < 1 minute), try to refresh
				if time.Unix(exp, 0).Before(time.Now().Add(1 * time.Minute)) {
					if creds.RefreshToken == "" {
						needsLogin = true
					} else {
						fmt.Println("Access token expired, refreshing...")
						newAccessToken, err := refreshAccessToken(creds.RefreshToken)
						if err != nil {
							needsLogin = true
						} else {
							creds.AccessToken = newAccessToken
							if err := saveCredentials(credsPath, creds); err != nil {
								return "", fmt.Errorf("failed to save new credentials: %w", err)
							}
							return newAccessToken, nil
						}
					}
				} else {
					return creds.AccessToken, nil
				}
			}
		}
	}

	if needsLogin {
		if !promptLogin {
			return "", fmt.Errorf("authentication required. Please run `alethia login`")
		}

		fmt.Println(ui.ErrorStyle.Render(ui.SymbolError + " You are not logged in or your session has expired."))
		fmt.Println()

		var confirmLogin bool
		err := huh.NewConfirm().
			Title("Would you like to log in now?").
			Affirmative("Yes").
			Negative("No").
			Value(&confirmLogin).
			Run()

		if err != nil || !confirmLogin {
			return "", fmt.Errorf("authentication required. Please run `alethia login`")
		}

		if err := performLoginFlow(); err != nil {
			return "", err
		}

		// Read credentials again after successful login
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

	return "", fmt.Errorf("unexpected authentication state")
}

func refreshAccessToken(refreshToken string) (string, error) {
	refreshURL := fmt.Sprintf("%s/api/auth/cli/refresh", WebOrigin())

	client := req.C()
	var result struct {
		AccessToken string `json:"access_token"`
	}
	var errMsg struct {
		Error string `json:"error"`
	}

	resp, err := client.R().
		SetBody(map[string]string{"refresh_token": refreshToken}).
		SetSuccessResult(&result).
		SetErrorResult(&errMsg).
		Post(refreshURL)

	if err != nil {
		return "", err
	}

	if resp.IsErrorState() {
		return "", fmt.Errorf("server returned %d: %s", resp.StatusCode, errMsg.Error)
	}

	return result.AccessToken, nil
}

func saveCredentials(path string, creds types.ExchangeResponse) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(creds)
}
