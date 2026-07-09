package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

const maxConfigurationBytes = 1 << 20

type validationResult struct {
	Valid  bool   `json:"valid"`
	Output string `json:"output"`
}

func redact(value string) string {
	for _, name := range []string{"VALIDATOR_TOKEN", "KAMEX_ADMIN_PASSWORD", "KAMEX_STATUS_PASSWORD", "POSTGRES_PASSWORD"} {
		if secret := os.Getenv(name); secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	return value
}

func authorized(request *http.Request) bool {
	expected := os.Getenv("VALIDATOR_TOKEN")
	actual := request.Header.Get("X-Validator-Token")
	return expected != "" && len(expected) == len(actual) && subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}

func validate(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Content-Type", "application/json")
	if request.Method != http.MethodPost {
		response.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !authorized(request) {
		response.WriteHeader(http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxConfigurationBytes))
	if err != nil || len(body) == 0 {
		http.Error(response, `{"valid":false,"output":"configuration is empty or exceeds 1 MiB"}`, http.StatusBadRequest)
		return
	}
	file, err := os.CreateTemp("", "jkannel-kamex-*.conf")
	if err != nil {
		http.Error(response, `{"valid":false,"output":"temporary file creation failed"}`, http.StatusInternalServerError)
		return
	}
	path := file.Name()
	defer os.Remove(path)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(body)
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		http.Error(response, `{"valid":false,"output":"temporary file write failed"}`, http.StatusInternalServerError)
		return
	}
	contextWithTimeout, cancel := context.WithTimeout(request.Context(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(contextWithTimeout, "/usr/sbin/bearerbox", "--test", path)
	output, commandErr := command.CombinedOutput()
	result := validationResult{Valid: commandErr == nil, Output: redact(string(output))}
	status := http.StatusOK
	if commandErr != nil {
		status = http.StatusUnprocessableEntity
	}
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(result)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(response http.ResponseWriter, _ *http.Request) { response.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("/validate", validate)
	server := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 12 * time.Second, WriteTimeout: 12 * time.Second, IdleTimeout: 30 * time.Second}
	log.Fatal(server.ListenAndServe())
}
