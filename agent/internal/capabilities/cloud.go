package capabilities

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	metadataBaseURL              = "http://169.254.169.254"
	metadataBaseURLOverrideEnv   = "PATCHBAY_ALLOW_METADATA_BASE_URL_OVERRIDE"
	metadataBaseURLOverrideParam = "baseUrl"
)

type cloudProbe func(context.Context, *http.Client, string) (map[string]string, bool, error)

func cloudMetadata(ctx context.Context, params map[string]any) (any, error) {
	timeoutMs := intParam(params, "timeoutMs", 800)
	if timeoutMs < 100 {
		timeoutMs = 100
	}
	if timeoutMs > 5_000 {
		timeoutMs = 5_000
	}

	timeout := time.Duration(timeoutMs) * time.Millisecond
	client := &http.Client{Timeout: timeout}
	baseURL := metadataBaseURLForParams(params)
	probes := map[string]string{}
	providers := []struct {
		name  string
		probe cloudProbe
	}{
		{name: "aws", probe: probeAWSMetadata},
		{name: "gcp", probe: probeGCPMetadata},
		{name: "azure", probe: probeAzureMetadata},
	}

	for _, provider := range providers {
		probeCtx, cancel := context.WithTimeout(ctx, timeout)
		metadata, matched, err := provider.probe(probeCtx, client, baseURL)
		cancel()

		if matched {
			probes[provider.name] = "matched"
			return map[string]any{
				"available": true,
				"provider":  provider.name,
				"metadata":  metadata,
				"probes":    probes,
				"timeoutMs": timeoutMs,
			}, nil
		}

		if err != nil {
			probes[provider.name] = safeMetadataError(err)
		} else {
			probes[provider.name] = "unavailable"
		}
	}

	return map[string]any{
		"available": false,
		"provider":  "unknown",
		"probes":    probes,
		"timeoutMs": timeoutMs,
	}, nil
}

func metadataBaseURLForParams(params map[string]any) string {
	if os.Getenv(metadataBaseURLOverrideEnv) != "true" {
		return metadataBaseURL
	}

	baseURL, ok := params[metadataBaseURLOverrideParam].(string)
	if !ok {
		return metadataBaseURL
	}

	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return metadataBaseURL
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return metadataBaseURL
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return metadataBaseURL
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return metadataBaseURL
	}
	if !isLoopbackHost(parsed.Hostname()) {
		return metadataBaseURL
	}

	parsed.Path = ""
	return strings.TrimRight(parsed.String(), "/")
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func probeAWSMetadata(ctx context.Context, client *http.Client, baseURL string) (map[string]string, bool, error) {
	token := ""
	tokenBody, status, err := metadataRequest(ctx, client, http.MethodPut, baseURL+"/latest/api/token", map[string]string{
		"X-aws-ec2-metadata-token-ttl-seconds": "60",
	})
	if err == nil && status == http.StatusOK {
		token = strings.TrimSpace(string(tokenBody))
	}

	headers := map[string]string{}
	if token != "" {
		headers["X-aws-ec2-metadata-token"] = token
	}

	body, status, err := metadataRequest(ctx, client, http.MethodGet, baseURL+"/latest/dynamic/instance-identity/document", headers)
	if err != nil {
		return nil, false, err
	}
	if status < 200 || status >= 300 {
		return nil, false, fmt.Errorf("aws metadata status %d", status)
	}

	var document struct {
		AccountID        string `json:"accountId"`
		Architecture     string `json:"architecture"`
		AvailabilityZone string `json:"availabilityZone"`
		ImageID          string `json:"imageId"`
		InstanceID       string `json:"instanceId"`
		InstanceType     string `json:"instanceType"`
		PrivateIP        string `json:"privateIp"`
		Region           string `json:"region"`
	}
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, false, err
	}
	if document.InstanceID == "" && document.Region == "" {
		return nil, false, fmt.Errorf("aws metadata document was empty")
	}

	metadata := map[string]string{}
	putMetadata(metadata, "accountId", document.AccountID)
	putMetadata(metadata, "architecture", document.Architecture)
	putMetadata(metadata, "availabilityZone", document.AvailabilityZone)
	putMetadata(metadata, "imageId", document.ImageID)
	putMetadata(metadata, "instanceId", document.InstanceID)
	putMetadata(metadata, "instanceType", document.InstanceType)
	putMetadata(metadata, "privateIp", document.PrivateIP)
	putMetadata(metadata, "region", document.Region)
	return metadata, true, nil
}

func probeGCPMetadata(ctx context.Context, client *http.Client, baseURL string) (map[string]string, bool, error) {
	headers := map[string]string{"Metadata-Flavor": "Google"}
	projectID, err := metadataText(ctx, client, baseURL+"/computeMetadata/v1/project/project-id", headers)
	if err != nil {
		return nil, false, err
	}

	instanceID, _ := metadataText(ctx, client, baseURL+"/computeMetadata/v1/instance/id", headers)
	instanceName, _ := metadataText(ctx, client, baseURL+"/computeMetadata/v1/instance/name", headers)
	zone, _ := metadataText(ctx, client, baseURL+"/computeMetadata/v1/instance/zone", headers)
	machineType, _ := metadataText(ctx, client, baseURL+"/computeMetadata/v1/instance/machine-type", headers)

	metadata := map[string]string{}
	putMetadata(metadata, "projectId", projectID)
	putMetadata(metadata, "instanceId", instanceID)
	putMetadata(metadata, "instanceName", instanceName)
	putMetadata(metadata, "zone", lastPathSegment(zone))
	putMetadata(metadata, "machineType", lastPathSegment(machineType))
	return metadata, true, nil
}

func probeAzureMetadata(ctx context.Context, client *http.Client, baseURL string) (map[string]string, bool, error) {
	body, status, err := metadataRequest(
		ctx,
		client,
		http.MethodGet,
		baseURL+"/metadata/instance/compute?api-version=2021-02-01",
		map[string]string{"Metadata": "true"},
	)
	if err != nil {
		return nil, false, err
	}
	if status < 200 || status >= 300 {
		return nil, false, fmt.Errorf("azure metadata status %d", status)
	}

	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, false, err
	}

	metadata := map[string]string{}
	for _, key := range []string{
		"location",
		"name",
		"osType",
		"resourceGroupName",
		"subscriptionId",
		"vmId",
		"vmSize",
		"zone",
	} {
		if value, ok := document[key].(string); ok {
			putMetadata(metadata, key, value)
		}
	}
	if len(metadata) == 0 {
		return nil, false, fmt.Errorf("azure metadata document was empty")
	}

	return metadata, true, nil
}

func metadataText(ctx context.Context, client *http.Client, url string, headers map[string]string) (string, error) {
	body, status, err := metadataRequest(ctx, client, http.MethodGet, url, headers)
	if err != nil {
		return "", err
	}
	if status < 200 || status >= 300 {
		return "", fmt.Errorf("metadata status %d", status)
	}
	return strings.TrimSpace(string(body)), nil
}

func metadataRequest(
	ctx context.Context,
	client *http.Client,
	method string,
	url string,
	headers map[string]string,
) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		return nil, 0, err
	}

	for key, value := range headers {
		request.Header.Set(key, value)
	}

	response, err := client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return body, response.StatusCode, nil
}

func putMetadata(metadata map[string]string, key string, value string) {
	value = strings.TrimSpace(Redact(value))
	if value == "" {
		return
	}
	if len(value) > 200 {
		value = value[:200] + "..."
	}
	metadata[key] = value
}

func lastPathSegment(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parts := strings.Split(value, "/")
	return parts[len(parts)-1]
}

func safeMetadataError(err error) string {
	message := strings.TrimSpace(Redact(err.Error()))
	if message == "" {
		return "unavailable"
	}
	message = strings.ReplaceAll(message, "\n", " ")
	if len(message) > 160 {
		return message[:160] + "..."
	}
	return message
}
