package worker

import (
	"fmt"
	"os"
)

func ActivateGcpWIF(wifConfigJSON string) (func(), error) {
	if wifConfigJSON == "" {
		return nil, fmt.Errorf("empty WIF config")
	}

	tmpFile, err := os.CreateTemp("", "grape-wif-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file: %w", err)
	}

	if _, err := tmpFile.Write([]byte(wifConfigJSON)); err != nil {
		tmpFile.Close()
		os.Remove(tmpFile.Name())
		return nil, fmt.Errorf("failed to write WIF config: %w", err)
	}
	tmpFile.Close()

	os.Setenv("GOOGLE_APPLICATION_CREDENTIALS", tmpFile.Name())

	cleanup := func() {
		os.Unsetenv("GOOGLE_APPLICATION_CREDENTIALS")
		os.Remove(tmpFile.Name())
	}

	return cleanup, nil
}
