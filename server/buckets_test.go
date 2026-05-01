package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newBucketTestServer(t *testing.T) *Server {
	t.Helper()
	store := &Store{dataDir: t.TempDir(), state: AppState{Users: map[string]*User{}, Buckets: map[string]*BucketConfig{}, Tasks: map[string]*GenerationTask{}, Settings: AdminSettings{BaseURL: "https://api.openai.com/v1", Model: "gpt-image-2", Timeout: 300, APIMode: "images"}, FailureLogs: []FailureLog{}, AuditLogs: []AuditLog{}}}
	return &Server{dataDir: store.dataDir, staticDir: "./dist", store: store, sessions: &SessionStore{items: map[string]*Session{}}, adminKey: "test-admin", cookieKey: []byte("01234567890123456789012345678901")}
}

func performAdminRequest(s *Server, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	if strings.HasPrefix(path, "/api/admin/buckets/") {
		s.handleAdminBucketByID(rr, req, &Session{UserID: "admin", Username: "管理员", Role: "admin"})
	} else {
		s.handleAdminBuckets(rr, req, &Session{UserID: "admin", Username: "管理员", Role: "admin"})
	}
	return rr
}

func TestAdminBucketsCreateListAndEdit(t *testing.T) {
	s := newBucketTestServer(t)
	create := performAdminRequest(s, http.MethodPost, "/api/admin/buckets", `{"name":"我的腾讯云","region":"ap-nanjing","bucket":"gptimage-1325670071","secretId":"sid","secretKey":"skey","pathPrefix":"image_playground","tempUrlMinutes":2880}`)
	if create.Code != http.StatusOK {
		t.Fatalf("create bucket status=%d body=%s", create.Code, create.Body.String())
	}

	state := s.store.snapshot()
	if len(state.Buckets) != 1 {
		t.Fatalf("expected one bucket, got %d", len(state.Buckets))
	}
	var id string
	for bucketID, bucket := range state.Buckets {
		id = bucketID
		if bucket.Region != "ap-nanjing" || bucket.Bucket != "gptimage-1325670071" {
			t.Fatalf("bucket region/name not saved: %#v", bucket)
		}
	}

	update := performAdminRequest(s, http.MethodPut, "/api/admin/buckets/"+id, `{"name":"编辑后","region":"ap-shanghai","bucket":"edited-1325670071","secretId":"sid2","secretKey":"skey2","pathPrefix":"edited","tempUrlMinutes":1440}`)
	if update.Code != http.StatusOK {
		t.Fatalf("update bucket status=%d body=%s", update.Code, update.Body.String())
	}

	list := performAdminRequest(s, http.MethodGet, "/api/admin/buckets", "")
	if list.Code != http.StatusOK {
		t.Fatalf("list bucket status=%d body=%s", list.Code, list.Body.String())
	}
	var payload struct {
		Buckets []BucketConfig `json:"buckets"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Buckets) != 1 {
		t.Fatalf("expected one listed bucket, got %d", len(payload.Buckets))
	}
	if payload.Buckets[0].Name != "编辑后" || payload.Buckets[0].Region != "ap-shanghai" || payload.Buckets[0].Bucket != "edited-1325670071" || payload.Buckets[0].PathPrefix != "edited" || payload.Buckets[0].TempURLMinutes != 1440 {
		t.Fatalf("listed bucket not updated: %#v", payload.Buckets[0])
	}
	if payload.Buckets[0].SecretID != "sid2" || payload.Buckets[0].SecretKey != "skey2" {
		t.Fatalf("listed bucket should include editable credentials for admin: %#v", payload.Buckets[0])
	}
}

func TestAdminBucketsDelete(t *testing.T) {
	s := newBucketTestServer(t)
	create := performAdminRequest(s, http.MethodPost, "/api/admin/buckets", `{"name":"待删除","region":"ap-nanjing","bucket":"gptimage-1325670071","secretId":"sid","secretKey":"skey"}`)
	if create.Code != http.StatusOK {
		t.Fatalf("create bucket status=%d body=%s", create.Code, create.Body.String())
	}

	var id string
	for bucketID := range s.store.snapshot().Buckets {
		id = bucketID
	}
	deleteResp := performAdminRequest(s, http.MethodDelete, "/api/admin/buckets/"+id, "")
	if deleteResp.Code != http.StatusOK {
		t.Fatalf("delete bucket status=%d body=%s", deleteResp.Code, deleteResp.Body.String())
	}
	if got := len(s.store.snapshot().Buckets); got != 0 {
		t.Fatalf("expected buckets to be deleted, got %d", got)
	}
}

func TestAdminBucketsRejectMissingRegionOrBucket(t *testing.T) {
	s := newBucketTestServer(t)
	resp := performAdminRequest(s, http.MethodPost, "/api/admin/buckets", `{"name":"bad","secretId":"sid","secretKey":"skey"}`)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d body=%s", resp.Code, resp.Body.String())
	}
}

func TestCosBucketURLUsesRegionAndBucket(t *testing.T) {
	got := cosBucketURL(&BucketConfig{Region: "ap-nanjing", Bucket: "gptimage-1325670071"})
	want := "https://gptimage-1325670071.cos.ap-nanjing.myqcloud.com"
	if got != want {
		t.Fatalf("cosBucketURL()=%q want %q", got, want)
	}
}
