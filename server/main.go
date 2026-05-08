package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tencentyun/cos-go-sdk-v5"
)

const (
	cookieName      = "gip_session"
	defaultDataDir  = "/data"
	defaultBindAddr = ":8080"
	releaseRepo     = "LingyeNBird/gpt_image_playground_distribution"
	promptRewriteGuardPrefix = "Use the following text as the complete prompt. Do not rewrite it:"
)

var (
	backendVersion  = "dev"
	frontendVersion = "dev"
	updateMu        sync.Mutex
)

type Server struct {
	dataDir   string
	staticDir string
	store     *Store
	sessions  *SessionStore
	adminKey  string
	cookieKey []byte
}

type Store struct {
	mu      sync.Mutex
	dataDir string
	state   AppState
}

type AppState struct {
	Users       map[string]*User           `json:"users"`
	Settings    AdminSettings              `json:"settings"`
	Buckets     map[string]*BucketConfig   `json:"buckets"`
	Tasks       map[string]*GenerationTask `json:"tasks"`
	FailureLogs []FailureLog               `json:"failureLogs"`
	AuditLogs   []AuditLog                 `json:"auditLogs"`
}

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	Disabled     bool   `json:"disabled"`
	Banned       bool   `json:"banned"`
	QuotaTotal   int    `json:"quotaTotal"`
	QuotaUsed    int    `json:"quotaUsed"`
	AllowDirect  bool   `json:"allowDirect"`
	AllowBucket  bool   `json:"allowBucket"`
	CreatedAt    int64  `json:"createdAt"`
	LastSeenAt   int64  `json:"lastSeenAt"`
}

type AdminSettings struct {
	BaseURL  string `json:"baseUrl"`
	APIKey   string `json:"apiKey"`
	Model    string `json:"model"`
	Timeout  int    `json:"timeout"`
	APIMode  string `json:"apiMode"`
	CodexCLI bool   `json:"codexCli"`
}

type BucketConfig struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Region         string `json:"region"`
	Bucket         string `json:"bucket"`
	SecretID       string `json:"secretId"`
	SecretKey      string `json:"secretKey"`
	PathPrefix     string `json:"pathPrefix"`
	TempURLMinutes int    `json:"tempUrlMinutes"`
	CreatedAt      int64  `json:"createdAt"`
}

type GenerationTask struct {
	ID               string           `json:"id"`
	UserID           string           `json:"userId"`
	Username         string           `json:"username"`
	Prompt           string           `json:"prompt"`
	Params           map[string]any   `json:"params"`
	Mode             string           `json:"mode"`
	Endpoint         string           `json:"endpoint,omitempty"`
	Status           string           `json:"status"`
	Error            string           `json:"error,omitempty"`
	Images           []GeneratedImage `json:"images,omitempty"`
	ActualParams     map[string]any   `json:"actualParams,omitempty"`
	ActualParamsList []map[string]any `json:"actualParamsList,omitempty"`
	RevisedPrompts   []string         `json:"revisedPrompts,omitempty"`
	Timings          []TaskTiming     `json:"timings,omitempty"`
	CreatedAt        int64            `json:"createdAt"`
	FinishedAt       int64            `json:"finishedAt,omitempty"`
	Elapsed          int64            `json:"elapsed,omitempty"`
}

type TaskTiming struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Duration int64  `json:"duration"`
	Detail   string `json:"detail,omitempty"`
}

type GeneratedImage struct {
	DataURL   string `json:"dataUrl,omitempty"`
	URL       string `json:"url,omitempty"`
	ObjectKey string `json:"objectKey,omitempty"`
}

type FailureLog struct {
	ID        string `json:"id"`
	UserID    string `json:"userId"`
	Username  string `json:"username"`
	TaskID    string `json:"taskId"`
	Prompt    string `json:"prompt"`
	Error     string `json:"error"`
	CreatedAt int64  `json:"createdAt"`
}

type AuditLog struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	UserID    string `json:"userId,omitempty"`
	Username  string `json:"username,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

type Session struct {
	ID         string
	UserID     string
	Username   string
	Role       string
	LastSeenAt int64
}

type SessionStore struct {
	mu    sync.Mutex
	items map[string]*Session
}

type publicUser struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	Disabled       bool   `json:"disabled"`
	Banned         bool   `json:"banned"`
	QuotaTotal     int    `json:"quotaTotal"`
	QuotaUsed      int    `json:"quotaUsed"`
	QuotaRemaining int    `json:"quotaRemaining"`
	AllowDirect    bool   `json:"allowDirect"`
	AllowBucket    bool   `json:"allowBucket"`
	CreatedAt      int64  `json:"createdAt"`
	LastSeenAt     int64  `json:"lastSeenAt"`
	Online         bool   `json:"online"`
	RunningTasks   int    `json:"runningTasks"`
}

func main() {
	dataDir := getenv("DATA_DIR", defaultDataDir)
	staticDir := getenv("STATIC_DIR", "./dist")
	addr := getenv("ADDR", defaultBindAddr)
	log.Printf("Starting gpt-image-playground (backend=%s, frontend=%s)", backendVersion, frontendVersion)
	log.Printf("Data directory: %s (mount to persist across restarts)", dataDir)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	adminKey, err := ensureAdminKey(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("IMPORTANT: admin key: %s", adminKey)
	store, err := NewStore(dataDir)
	if err != nil {
		log.Fatal(err)
	}
	s := &Server{dataDir: dataDir, staticDir: staticDir, store: store, sessions: &SessionStore{items: map[string]*Session{}}, adminKey: adminKey, cookieKey: deriveCookieKey(dataDir)}
	mux := http.NewServeMux()
	s.routes(mux)
	log.Printf("gpt-image-playground listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("/api/auth/register", s.handleRegister)
	mux.HandleFunc("/api/auth/login", s.handleLogin)
	mux.HandleFunc("/api/auth/logout", s.handleLogout)
	mux.HandleFunc("/api/auth/me", s.handleMe)
	mux.HandleFunc("/api/version", s.handleVersion)
	mux.HandleFunc("/api/generate", s.requireUser(s.handleGenerate))
	mux.HandleFunc("/api/tasks", s.requireUser(s.handleTasks))
	mux.HandleFunc("/api/tasks/", s.requireUser(s.handleTaskByID))
	mux.HandleFunc("/api/admin/settings", s.requireAdmin(s.handleAdminSettings))
	mux.HandleFunc("/api/admin/settings/test-url", s.requireAdmin(s.handleAdminSettingsTestURL))
	mux.HandleFunc("/api/admin/settings/verify-key", s.requireAdmin(s.handleAdminSettingsVerifyKey))
	mux.HandleFunc("/api/admin/users", s.requireAdmin(s.handleAdminUsers))
	mux.HandleFunc("/api/admin/users/", s.requireAdmin(s.handleAdminUserByID))
	mux.HandleFunc("/api/admin/buckets", s.requireAdmin(s.handleAdminBuckets))
	mux.HandleFunc("/api/admin/buckets/", s.requireAdmin(s.handleAdminBucketByID))
	mux.HandleFunc("/api/admin/failures", s.requireAdmin(s.handleAdminFailures))
	mux.HandleFunc("/api/admin/audit", s.requireAdmin(s.handleAdminAudit))
	mux.HandleFunc("/api/admin/tasks", s.requireAdmin(s.handleAdminTasks))
	mux.HandleFunc("/api/admin/update/check", s.requireAdmin(s.handleUpdateCheck))
	mux.HandleFunc("/api/admin/update/backend", s.requireAdmin(s.handleUpdateBackend))
	mux.HandleFunc("/api/admin/update/frontend", s.requireAdmin(s.handleUpdateFrontend))
	mux.HandleFunc("/api/admin/update/restart", s.requireAdmin(s.handleRestart))
	mux.HandleFunc("/", s.handleStatic)
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, map[string]string{"backendVersion": backendVersion, "frontendVersion": frontendVersion})
}

func NewStore(dataDir string) (*Store, error) {
	st := &Store{dataDir: dataDir}
	if err := st.load(); err != nil {
		return nil, err
	}
	return st, nil
}

func (st *Store) load() error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.state = AppState{Users: map[string]*User{}, Buckets: map[string]*BucketConfig{}, Tasks: map[string]*GenerationTask{}, Settings: AdminSettings{BaseURL: "https://api.openai.com/v1", Model: "gpt-image-2", Timeout: 300, APIMode: "images"}}
	path := filepath.Join(st.dataDir, "state.json")
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		log.Printf("state.json not found at %s, creating with defaults", path)
		return st.saveLocked()
	}
	if err != nil {
		log.Printf("ERROR: failed to read %s: %v", path, err)
		return err
	}
	if len(bytes.TrimSpace(b)) == 0 {
		log.Printf("WARNING: %s is empty, keeping in-memory defaults (existing data NOT overwritten)", path)
		return nil
	}
	if err := json.Unmarshal(b, &st.state); err != nil {
		log.Printf("ERROR: failed to parse %s: %v", path, err)
		return err
	}
	log.Printf("Loaded state from %s (%d bytes)", path, len(b))
	if st.state.Users == nil {
		st.state.Users = map[string]*User{}
	}
	if st.state.Buckets == nil {
		st.state.Buckets = map[string]*BucketConfig{}
	}
	if st.state.Tasks == nil {
		st.state.Tasks = map[string]*GenerationTask{}
	}
	if st.state.FailureLogs == nil {
		st.state.FailureLogs = []FailureLog{}
	}
	if st.state.AuditLogs == nil {
		st.state.AuditLogs = []AuditLog{}
	}
	if st.state.Settings.Timeout == 0 {
		st.state.Settings.Timeout = 300
	}
	if st.state.Settings.BaseURL == "" {
		st.state.Settings.BaseURL = "https://api.openai.com/v1"
	}
	if st.state.Settings.Model == "" {
		st.state.Settings.Model = "gpt-image-2"
	}
	if st.state.Settings.APIMode == "" {
		st.state.Settings.APIMode = "images"
	}
	return nil
}

func (st *Store) saveLocked() error {
	b, err := json.MarshalIndent(st.state, "", "  ")
	if err != nil {
		log.Printf("ERROR: saveLocked marshal failed: %v", err)
		return err
	}
	path := filepath.Join(st.dataDir, "state.json")
	tmp := path + ".tmp"
	bak := path + ".bak"

	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("ERROR: saveLocked write temp failed: %v", err)
		return err
	}
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		bakData, _ := os.ReadFile(path)
		if len(bakData) > 0 {
			_ = os.WriteFile(bak, bakData, 0o600)
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		log.Printf("ERROR: saveLocked rename failed: %v", err)
		return err
	}
	log.Printf("State saved to %s (%d bytes)", path, len(b))
	return nil
}

func (st *Store) with(fn func(*AppState) error) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := fn(&st.state); err != nil {
		return err
	}
	return st.saveLocked()
}

func appendAudit(st *AppState, typ, title, detail, userID, username string) {
	st.AuditLogs = append([]AuditLog{{ID: randomHex(12), Type: typ, Title: title, Detail: detail, UserID: userID, Username: username, CreatedAt: nowMs()}}, st.AuditLogs...)
	if len(st.AuditLogs) > 5000 {
		st.AuditLogs = st.AuditLogs[:5000]
	}
}

func (s *Server) handleAdminBucketByID(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/buckets/")
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		methodNotAllowed(w)
		return
	}
	if r.Method == http.MethodDelete {
		var deletedName string
		err := s.store.with(func(st *AppState) error {
			current := st.Buckets[id]
			if current == nil {
				return errors.New("存储桶不存在")
			}
			deletedName = current.Name
			delete(st.Buckets, id)
			appendAudit(st, "bucket_delete", "存储桶已删除", fmt.Sprintf("管理员删除了存储桶“%s”。", deletedName), "admin", "管理员")
			return nil
		})
		if err != nil {
			httpError(w, 404, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true})
		return
	}
	var req BucketConfig
	if !decodeJSON(w, r, &req) {
		return
	}
	if err := normalizeBucketConfig(&req); err != nil {
		httpError(w, 400, err.Error())
		return
	}
	err := s.store.with(func(st *AppState) error {
		current := st.Buckets[id]
		if current == nil {
			return errors.New("存储桶不存在")
		}
		req.ID = id
		req.CreatedAt = current.CreatedAt
		st.Buckets[id] = &req
		appendAudit(st, "bucket_update", "存储桶已更新", fmt.Sprintf("管理员更新了存储桶“%s”。", req.Name), "admin", "管理员")
		return nil
	})
	if err != nil {
		httpError(w, 404, err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "bucket": req})
}

func (st *Store) snapshot() AppState {
	st.mu.Lock()
	defer st.mu.Unlock()
	b, _ := json.Marshal(st.state)
	var cp AppState
	_ = json.Unmarshal(b, &cp)
	return cp
}

func (ss *SessionStore) create(userID, username, role string) *Session {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	s := &Session{ID: randomHex(32), UserID: userID, Username: username, Role: role, LastSeenAt: nowMs()}
	ss.items[s.ID] = s
	return s
}

func (ss *SessionStore) get(id string) (*Session, bool) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	s, ok := ss.items[id]
	if !ok {
		return nil, false
	}
	s.LastSeenAt = nowMs()
	return s, true
}

func (ss *SessionStore) delete(id string) { ss.mu.Lock(); delete(ss.items, id); ss.mu.Unlock() }
func (ss *SessionStore) onlineUserIDs() map[string]bool {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	cutoff := nowMs() - int64((5*time.Minute)/time.Millisecond)
	m := map[string]bool{}
	for id, sess := range ss.items {
		if sess.LastSeenAt < cutoff {
			delete(ss.items, id)
			continue
		}
		if sess.Role == "user" {
			m[sess.UserID] = true
		}
	}
	return m
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct{ Username, Password string }
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	if !validUsername(req.Username) || len(req.Password) < 4 {
		httpError(w, 400, "用户名格式不正确或密码太短")
		return
	}
	var user *User
	err := s.store.with(func(st *AppState) error {
		for _, u := range st.Users {
			if strings.EqualFold(u.Username, req.Username) {
				return errors.New("用户名已存在")
			}
		}
		user = &User{ID: randomHex(12), Username: req.Username, PasswordHash: hashPassword(req.Password), QuotaTotal: 0, AllowDirect: true, AllowBucket: false, CreatedAt: nowMs(), LastSeenAt: nowMs()}
		st.Users[user.ID] = user
		appendAudit(st, "user_register", "用户注册", fmt.Sprintf("%s 注册了新账号。", user.Username), user.ID, user.Username)
		return nil
	})
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	sess := s.sessions.create(user.ID, user.Username, "user")
	s.setSessionCookie(w, sess)
	writeJSON(w, map[string]any{"user": s.publicCurrentUser(user, "user")})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct{ Username, Password, AdminKey, Role string }
	if !decodeJSON(w, r, &req) {
		return
	}
	req.Role = strings.TrimSpace(req.Role)
	if req.Role == "admin" {
		if !hmac.Equal([]byte(req.AdminKey), []byte(s.adminKey)) {
			httpError(w, 401, "管理员密钥不正确")
			return
		}
		sess := s.sessions.create("admin", "管理员", "admin")
		s.setSessionCookie(w, sess)
		_ = s.store.with(func(st *AppState) error {
			appendAudit(st, "admin_login", "管理员登录", "管理员已成功登录。", "admin", "管理员")
			return nil
		})
		writeJSON(w, map[string]any{"user": map[string]any{"id": "admin", "username": "管理员", "role": "admin"}})
		return
	}
	var user *User
	state := s.store.snapshot()
	for _, u := range state.Users {
		if strings.EqualFold(u.Username, strings.TrimSpace(req.Username)) {
			user = u
			break
		}
	}
	if user == nil || !checkPassword(req.Password, user.PasswordHash) {
		httpError(w, 401, "账号或密码错误")
		return
	}
	if user.Disabled || user.Banned {
		httpError(w, 403, "账号已被禁用或封禁")
		return
	}
	_ = s.store.with(func(st *AppState) error {
		if u := st.Users[user.ID]; u != nil {
			u.LastSeenAt = nowMs()
		}
		appendAudit(st, "user_login", "用户登录", fmt.Sprintf("%s 已成功登录。", user.Username), user.ID, user.Username)
		return nil
	})
	sess := s.sessions.create(user.ID, user.Username, "user")
	s.setSessionCookie(w, sess)
	writeJSON(w, map[string]any{"user": s.publicCurrentUser(user, "user")})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		s.sessions.delete(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	sess, ok := s.sessionFromRequest(r)
	if !ok {
		writeJSON(w, map[string]any{"user": nil})
		return
	}
	if sess.Role == "admin" {
		writeJSON(w, map[string]any{"user": map[string]any{"id": "admin", "username": "管理员", "role": "admin"}})
		return
	}
	state := s.store.snapshot()
	u := state.Users[sess.UserID]
	if u == nil || u.Disabled || u.Banned {
		httpError(w, 401, "登录已失效")
		return
	}
	writeJSON(w, map[string]any{"user": s.publicCurrentUser(u, "user")})
}

func (s *Server) handleGenerate(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct {
		Prompt             string         `json:"prompt"`
		Params             map[string]any `json:"params"`
		InputImageDataURLs []string       `json:"inputImageDataUrls"`
		MaskDataURL        string         `json:"maskDataUrl"`
		Mode               string         `json:"mode"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		httpError(w, 400, "请输入提示词")
		return
	}
	state := s.store.snapshot()
	mode := req.Mode
	if mode != "bucket" {
		mode = "direct"
	}
	username := sess.Username
	if sess.Role != "admin" {
		user := state.Users[sess.UserID]
		if user == nil || user.Disabled || user.Banned {
			httpError(w, 403, "账号不可用")
			return
		}
		username = user.Username
		if mode == "direct" && !user.AllowDirect {
			httpError(w, 403, "未开启直传模式")
			return
		}
		if mode == "bucket" && !user.AllowBucket {
			httpError(w, 403, "未开启存储桶模式")
			return
		}
		if user.QuotaTotal <= user.QuotaUsed {
			httpError(w, 403, "生图额度不足")
			return
		}
	}
	settings := state.Settings
	if settings.APIKey == "" {
		httpError(w, 500, "管理员尚未配置上游 API Key")
		return
	}
	task := &GenerationTask{ID: randomHex(12), UserID: sess.UserID, Username: username, Prompt: strings.TrimSpace(req.Prompt), Params: req.Params, Mode: mode, Status: "running", CreatedAt: nowMs()}
	if err := s.store.with(func(st *AppState) error {
		st.Tasks[task.ID] = task
		appendAudit(st, "generation_start", "生图任务已提交", fmt.Sprintf("%s 提交了%s模式生图任务。", task.Username, displayMode(task.Mode)), task.UserID, task.Username)
		return nil
	}); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	go s.executeGeneration(task.ID, settings, req.InputImageDataURLs, req.MaskDataURL)
	writeJSON(w, task)
}

func (s *Server) handleTasks(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	state := s.store.snapshot()
	var tasks []*GenerationTask
	for _, t := range state.Tasks {
		if t.UserID == sess.UserID {
			tasks = append(tasks, sanitizeTaskForUser(t))
		}
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].CreatedAt > tasks[j].CreatedAt })
	writeJSON(w, map[string]any{"tasks": tasks})
}

func (s *Server) handleTaskByID(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := strings.TrimPrefix(r.URL.Path, "/api/tasks/")
	state := s.store.snapshot()
	t := state.Tasks[id]
	if t == nil || t.UserID != sess.UserID {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, sanitizeTaskForUser(t))
}

func (s *Server) handleAdminSettings(w http.ResponseWriter, r *http.Request, sess *Session) {
	switch r.Method {
	case http.MethodGet:
		settings := s.store.snapshot().Settings
		settings.APIKey = maskSecret(settings.APIKey)
		writeJSON(w, settings)
	case http.MethodPut:
		var req AdminSettings
		if !decodeJSON(w, r, &req) {
			return
		}
		err := s.store.with(func(st *AppState) error {
			if req.APIKey == "********" {
				req.APIKey = st.Settings.APIKey
			}
			if req.Timeout == 0 {
				req.Timeout = 300
			}
			st.Settings = req
			return nil
		})
		if err != nil {
			httpError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleAdminSettingsTestURL(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req AdminSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	settings := s.resolveTestSettings(req)
	endpoint, err := upstreamEndpoint(settings.BaseURL, "/models")
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	client := http.Client{Timeout: 8 * time.Second}
	request, _ := http.NewRequest(http.MethodGet, endpoint, nil)
	request.Header.Set("User-Agent", "gpt-image-playground-distribution-tester")
	resp, err := client.Do(request)
	if err != nil {
		httpError(w, 502, "连接失败："+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		httpError(w, 502, fmt.Sprintf("端点可连接，但上游返回 HTTP %d", resp.StatusCode))
		return
	}
	writeJSON(w, map[string]any{"ok": true, "message": fmt.Sprintf("端点可连接，返回 HTTP %d", resp.StatusCode)})
}

func (s *Server) handleAdminSettingsVerifyKey(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req AdminSettings
	if !decodeJSON(w, r, &req) {
		return
	}
	settings := s.resolveTestSettings(req)
	if strings.TrimSpace(settings.APIKey) == "" || settings.APIKey == "********" {
		httpError(w, 400, "请先填写上游 API Key")
		return
	}
	endpoint, err := upstreamEndpoint(settings.BaseURL, "/models")
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	client := http.Client{Timeout: 10 * time.Second}
	request, _ := http.NewRequest(http.MethodGet, endpoint, nil)
	request.Header.Set("Authorization", "Bearer "+settings.APIKey)
	request.Header.Set("User-Agent", "gpt-image-playground-distribution-tester")
	resp, err := client.Do(request)
	if err != nil {
		httpError(w, 502, "验证失败："+err.Error())
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		httpError(w, 401, fmt.Sprintf("API Key 鉴权未通过：HTTP %d", resp.StatusCode))
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpError(w, 502, fmt.Sprintf("上游返回 HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(body))))
		return
	}
	writeJSON(w, map[string]any{"ok": true, "message": "API Key 鉴权通过"})
}

func (s *Server) resolveTestSettings(req AdminSettings) AdminSettings {
	current := s.store.snapshot().Settings
	req.BaseURL = strings.TrimSpace(req.BaseURL)
	if req.BaseURL == "" {
		req.BaseURL = current.BaseURL
	}
	if req.APIKey == "********" {
		req.APIKey = current.APIKey
	}
	if req.Model == "" {
		req.Model = current.Model
	}
	if req.Timeout <= 0 {
		req.Timeout = current.Timeout
	}
	if req.APIMode == "" {
		req.APIMode = current.APIMode
	}
	return req
}

func (s *Server) handleAdminUsers(w http.ResponseWriter, r *http.Request, sess *Session) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, map[string]any{"users": s.adminUsers()})
	case http.MethodPost:
		var req struct {
			Username, Password string
			QuotaTotal         int
		}
		if !decodeJSON(w, r, &req) {
			return
		}
		req.Username = strings.TrimSpace(req.Username)
		if req.Username == "" || req.Password == "" {
			httpError(w, 400, "请填写用户名和密码")
			return
		}
		createdID := ""
		err := s.store.with(func(st *AppState) error {
			for _, u := range st.Users {
				if strings.EqualFold(u.Username, req.Username) {
					return errors.New("用户名已存在")
				}
			}
			id := randomHex(12)
			st.Users[id] = &User{ID: id, Username: req.Username, PasswordHash: hashPassword(req.Password), QuotaTotal: req.QuotaTotal, AllowDirect: true, CreatedAt: nowMs(), LastSeenAt: nowMs()}
			createdID = id
			appendAudit(st, "user_create", "用户已创建", fmt.Sprintf("管理员创建了用户 %s。", req.Username), id, req.Username)
			return nil
		})
		if err != nil {
			httpError(w, 400, err.Error())
			return
		}
		user, _ := s.adminUser(createdID)
		writeJSON(w, map[string]any{"ok": true, "user": user})
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleAdminUserByID(w http.ResponseWriter, r *http.Request, sess *Session) {
	id := strings.TrimPrefix(r.URL.Path, "/api/admin/users/")
	if r.Method != http.MethodPatch {
		methodNotAllowed(w)
		return
	}
	var req struct {
		Disabled, Banned         *bool
		QuotaTotal               *int
		AllowDirect, AllowBucket *bool
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	err := s.store.with(func(st *AppState) error {
		u := st.Users[id]
		if u == nil {
			return errors.New("用户不存在")
		}
		changes := []string{}
		if req.Disabled != nil {
			u.Disabled = *req.Disabled
			changes = append(changes, fmt.Sprintf("禁用状态：%s", displayBool(*req.Disabled)))
		}
		if req.Banned != nil {
			u.Banned = *req.Banned
			u.Disabled = false
			changes = append(changes, fmt.Sprintf("封禁状态：%s", displayBool(*req.Banned)))
		}
		if req.QuotaTotal != nil {
			u.QuotaTotal = *req.QuotaTotal
			changes = append(changes, fmt.Sprintf("总额度：%d", *req.QuotaTotal))
		}
		if req.AllowDirect != nil {
			u.AllowDirect = *req.AllowDirect
			changes = append(changes, fmt.Sprintf("直传模式：%s", displayBool(*req.AllowDirect)))
		}
		if req.AllowBucket != nil {
			u.AllowBucket = *req.AllowBucket
			changes = append(changes, fmt.Sprintf("存储桶模式：%s", displayBool(*req.AllowBucket)))
		}
		if !u.Banned && !u.AllowDirect && !u.AllowBucket {
			if req.Banned != nil && !*req.Banned {
				u.AllowDirect = true
				changes = append(changes, "直传模式：开启")
			} else {
				return errors.New("至少开启一种分发模式")
			}
		}
		if !u.Banned && !u.AllowDirect && !u.AllowBucket {
			return errors.New("至少开启一种分发模式")
		}
		if len(changes) > 0 {
			appendAudit(st, "user_update", "用户已更新", fmt.Sprintf("管理员更新了 %s：%s。", u.Username, strings.Join(changes, "，")), u.ID, u.Username)
		}
		return nil
	})
	if err != nil {
		httpError(w, 400, err.Error())
		return
	}
	user, ok := s.adminUser(id)
	if !ok {
		httpError(w, 404, "用户不存在")
		return
	}
	writeJSON(w, map[string]any{"ok": true, "user": user})
}

func (s *Server) handleAdminBuckets(w http.ResponseWriter, r *http.Request, sess *Session) {
	switch r.Method {
	case http.MethodGet:
		state := s.store.snapshot()
		out := []map[string]any{}
		for _, b := range state.Buckets {
			out = append(out, map[string]any{"id": b.ID, "name": b.Name, "region": b.Region, "bucket": b.Bucket, "secretId": b.SecretID, "secretKey": b.SecretKey, "pathPrefix": b.PathPrefix, "tempUrlMinutes": b.TempURLMinutes, "imageCount": s.countBucketImages(b), "createdAt": b.CreatedAt})
		}
		sort.Slice(out, func(i, j int) bool { return toInt64(out[i]["createdAt"]) > toInt64(out[j]["createdAt"]) })
		writeJSON(w, map[string]any{"buckets": out})
	case http.MethodPost:
		var req BucketConfig
		if !decodeJSON(w, r, &req) {
			return
		}
		if err := normalizeBucketConfig(&req); err != nil {
			httpError(w, 400, err.Error())
			return
		}
		err := s.store.with(func(st *AppState) error {
			req.ID = randomHex(12)
			req.CreatedAt = nowMs()
			st.Buckets[req.ID] = &req
			appendAudit(st, "bucket_create", "存储桶已添加", fmt.Sprintf("管理员连接了存储桶“%s”。", req.Name), "admin", "管理员")
			return nil
		})
		if err != nil {
			httpError(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) handleAdminFailures(w http.ResponseWriter, r *http.Request, sess *Session) {
	state := s.store.snapshot()
	failures := state.FailureLogs
	if failures == nil {
		failures = []FailureLog{}
	}
	writeJSON(w, map[string]any{"failures": failures})
}

func (s *Server) handleAdminAudit(w http.ResponseWriter, r *http.Request, sess *Session) {
	state := s.store.snapshot()
	audit := state.AuditLogs
	if audit == nil {
		audit = []AuditLog{}
	}
	offset := max(0, toInt(r.URL.Query().Get("offset")))
	limit := toInt(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	if offset > len(audit) {
		offset = len(audit)
	}
	end := offset + limit
	if end > len(audit) {
		end = len(audit)
	}
	writeJSON(w, map[string]any{"audit": audit[offset:end], "total": len(audit), "offset": offset, "limit": limit, "hasMore": end < len(audit)})
}

func (s *Server) handleAdminTasks(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	state := s.store.snapshot()
	tasks := make([]*GenerationTask, 0, len(state.Tasks))
	for _, task := range state.Tasks {
		copy := *task
		tasks = append(tasks, &copy)
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].CreatedAt > tasks[j].CreatedAt })
	writeJSON(w, map[string]any{"tasks": tasks})
}

func (s *Server) executeGeneration(taskID string, settings AdminSettings, inputImages []string, maskDataURL string) {
	started := nowMs()
	state := s.store.snapshot()
	task := state.Tasks[taskID]
	if task == nil {
		return
	}
	images, actual, actualList, revised, endpoint, timings, err := s.callUpstream(settings, task, inputImages, maskDataURL)
	if err != nil {
		clean := sanitizeError(err.Error(), settings.BaseURL)
		_ = s.store.with(func(st *AppState) error {
			t := st.Tasks[taskID]
			if t == nil {
				return nil
			}
			t.Endpoint = endpoint
			t.Timings = timings
			t.Status = "error"
			t.Error = clean
			t.FinishedAt = nowMs()
			t.Elapsed = t.FinishedAt - started
			st.FailureLogs = append([]FailureLog{{ID: randomHex(12), UserID: t.UserID, Username: t.Username, TaskID: t.ID, Prompt: t.Prompt, Error: sanitizeError(err.Error(), ""), CreatedAt: nowMs()}}, st.FailureLogs...)
			if len(st.FailureLogs) > 500 {
				st.FailureLogs = st.FailureLogs[:500]
			}
			return nil
		})
		return
	}
	state = s.store.snapshot()
	task = state.Tasks[taskID]
	generated := []GeneratedImage{}
	if task.Mode == "bucket" {
		bucket := firstBucket(state.Buckets)
		if bucket == nil {
			s.executeGenerationFailure(taskID, started, endpoint, timings, "管理员尚未配置存储桶")
			return
		}
		for i, dataURL := range images {
			uploadStarted := nowMs()
			url, key, upErr := s.uploadToCOS(bucket, taskID, i, dataURL)
			if upErr != nil {
				timings = append(timings, TaskTiming{Key: fmt.Sprintf("bucket_upload_%d", i+1), Label: fmt.Sprintf("上传存储桶 #%d", i+1), Duration: nowMs() - uploadStarted, Detail: sanitizeError(upErr.Error(), "")})
				s.executeGenerationFailure(taskID, started, endpoint, timings, upErr.Error())
				return
			}
			timings = append(timings, TaskTiming{Key: fmt.Sprintf("bucket_upload_%d", i+1), Label: fmt.Sprintf("上传存储桶 #%d", i+1), Duration: nowMs() - uploadStarted, Detail: key})
			generated = append(generated, GeneratedImage{URL: url, ObjectKey: key})
		}
	} else {
		for _, dataURL := range images {
			generated = append(generated, GeneratedImage{DataURL: dataURL})
		}
	}
	_ = s.store.with(func(st *AppState) error {
		t := st.Tasks[taskID]
		if t == nil {
			return nil
		}
		t.Endpoint = endpoint
		t.Timings = timings
		t.Status = "done"
		t.Images = generated
		t.ActualParams = actual
		t.ActualParamsList = actualList
		t.RevisedPrompts = revised
		t.FinishedAt = nowMs()
		t.Elapsed = t.FinishedAt - started
		if u := st.Users[t.UserID]; u != nil {
			u.QuotaUsed += len(generated)
		}
		return nil
	})
}

func (s *Server) executeGenerationFailure(taskID string, started int64, endpoint string, timings []TaskTiming, msg string) {
	_ = s.store.with(func(st *AppState) error {
		if t := st.Tasks[taskID]; t != nil {
			t.Endpoint = endpoint
			t.Timings = timings
			t.Status = "error"
			t.Error = msg
			t.FinishedAt = nowMs()
			t.Elapsed = t.FinishedAt - started
			st.FailureLogs = append([]FailureLog{{ID: randomHex(12), UserID: t.UserID, Username: t.Username, TaskID: t.ID, Prompt: t.Prompt, Error: msg, CreatedAt: nowMs()}}, st.FailureLogs...)
			if len(st.FailureLogs) > 500 {
				st.FailureLogs = st.FailureLogs[:500]
			}
		}
		return nil
	})
}

func (s *Server) callUpstream(settings AdminSettings, task *GenerationTask, inputImages []string, maskDataURL string) ([]string, map[string]any, []map[string]any, []string, string, []TaskTiming, error) {
	if settings.APIMode == "responses" {
		return nil, nil, nil, nil, "", nil, errors.New("后端 Responses API 代理暂未实现，请在管理员设置中使用 Images API")
	}
	if settings.CodexCLI {
		n := toInt(task.Params["n"])
		if n > 1 {
			return s.callUpstreamCodexCLIConcurrent(settings, task, inputImages, maskDataURL, n)
		}
	}

	return s.callUpstreamImages(settings, task, inputImages, maskDataURL)
}

func (s *Server) callUpstreamCodexCLIConcurrent(settings AdminSettings, task *GenerationTask, inputImages []string, maskDataURL string, n int) ([]string, map[string]any, []map[string]any, []string, string, []TaskTiming, error) {
	results := make([]struct {
		images  []string
		actual  map[string]any
		revised []string
		endpoint string
		timings []TaskTiming
		err     error
	}, n)
	var wg sync.WaitGroup

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			taskCopy := *task
			paramsCopy := map[string]any{}
			for k, v := range task.Params {
				paramsCopy[k] = v
			}
			paramsCopy["n"] = 1
			taskCopy.Params = paramsCopy
			images, actual, _, revised, endpoint, timings, err := s.callUpstreamImages(settings, &taskCopy, inputImages, maskDataURL)
			results[idx] = struct {
				images  []string
				actual  map[string]any
				revised []string
				endpoint string
				timings []TaskTiming
				err     error
			}{images: images, actual: actual, revised: revised, endpoint: endpoint, timings: timings, err: err}
		}(i)
	}
	wg.Wait()

	images := []string{}
	actualList := []map[string]any{}
	revised := []string{}
	endpoint := ""
	timings := []TaskTiming{}
	var mergedActual map[string]any
	for _, result := range results {
		if endpoint == "" && result.endpoint != "" {
			endpoint = result.endpoint
		}
		timings = append(timings, result.timings...)
		if result.err != nil {
			continue
		}
		images = append(images, result.images...)
		for range result.images {
			actualList = append(actualList, result.actual)
		}
		revised = append(revised, result.revised...)
		if mergedActual == nil && result.actual != nil {
			mergedActual = map[string]any{}
			for k, v := range result.actual {
				mergedActual[k] = v
			}
		}
	}

	if len(images) == 0 {
		for _, result := range results {
			if result.err != nil {
				return nil, nil, nil, nil, endpoint, timings, result.err
			}
		}
		return nil, nil, nil, nil, endpoint, timings, errors.New("所有并发请求均失败")
	}

	if mergedActual == nil {
		mergedActual = map[string]any{}
	}
	mergedActual["n"] = len(images)
	return images, mergedActual, actualList, revised, endpoint, timings, nil
}

func (s *Server) callUpstreamImages(settings AdminSettings, task *GenerationTask, inputImages []string, maskDataURL string) ([]string, map[string]any, []map[string]any, []string, string, []TaskTiming, error) {
	endpoint, err := upstreamEndpoint(settings.BaseURL, "/images/generations")
	if err != nil {
		return nil, nil, nil, nil, "", nil, err
	}
	var body io.Reader
	timings := []TaskTiming{}
	headers := map[string]string{"Authorization": "Bearer " + settings.APIKey, "Cache-Control": "no-store", "Pragma": "no-cache"}
	prompt := task.Prompt
	if settings.CodexCLI {
		prompt = promptRewriteGuardPrefix + "\n" + prompt
	}
	if len(inputImages) > 0 {
		endpoint, err = upstreamEndpoint(settings.BaseURL, "/images/edits")
		if err != nil {
			return nil, nil, nil, nil, "", nil, err
		}
		buf := &bytes.Buffer{}
		mw := multipart.NewWriter(buf)
		writeFormField(mw, "model", settings.Model)
		writeFormField(mw, "prompt", prompt)
		for k, v := range task.Params {
			if settings.CodexCLI && k == "quality" {
				continue
			}
			if k != "n" || toInt(v) > 1 {
				writeFormField(mw, k, fmt.Sprint(v))
			}
		}
		for i, dataURL := range inputImages {
			addDataURLFile(mw, "image[]", fmt.Sprintf("input-%d.png", i+1), dataURL)
		}
		if maskDataURL != "" {
			addDataURLFile(mw, "mask", "mask.png", maskDataURL)
		}
		_ = mw.Close()
		body = buf
		headers["Content-Type"] = mw.FormDataContentType()
	} else {
		payload := map[string]any{"model": settings.Model, "prompt": prompt}
		for k, v := range task.Params {
			if settings.CodexCLI && k == "quality" {
				continue
			}
			if k == "output_compression" && v == nil {
				continue
			}
			payload[k] = v
		}
		b, _ := json.Marshal(payload)
		body = bytes.NewReader(b)
		headers["Content-Type"] = "application/json"
	}
	client := http.Client{Timeout: time.Duration(settings.Timeout) * time.Second}
	req, _ := http.NewRequest(http.MethodPost, endpoint, body)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	requestStarted := nowMs()
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, nil, nil, endpoint, timings, err
	}
	timings = append(timings, TaskTiming{Key: "upstream_request", Label: "发送请求到获取响应", Duration: nowMs() - requestStarted, Detail: endpoint})
	defer resp.Body.Close()
	readStarted := nowMs()
	rb, _ := io.ReadAll(resp.Body)
	timings = append(timings, TaskTiming{Key: "upstream_read_body", Label: "读取响应体", Duration: nowMs() - readStarted})
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil, nil, nil, endpoint, timings, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(rb))
	}
	var payload map[string]any
	if err := json.Unmarshal(rb, &payload); err != nil {
		return nil, nil, nil, nil, endpoint, timings, err
	}
	arr, _ := payload["data"].([]any)
	if len(arr) == 0 {
		return nil, nil, nil, nil, endpoint, timings, errors.New("接口未返回图片数据")
	}
	mimeType := "image/png"
	if f, _ := task.Params["output_format"].(string); f != "" {
		mimeType = "image/" + f
	}
	images := []string{}
	revised := []string{}
	for _, item := range arr {
		m, _ := item.(map[string]any)
		if b64, _ := m["b64_json"].(string); b64 != "" {
			images = append(images, "data:"+mimeType+";base64,"+b64)
			timings = append(timings, TaskTiming{Key: fmt.Sprintf("image_decode_%d", len(images)), Label: fmt.Sprintf("生成图片数据 #%d", len(images)), Duration: 0})
		} else if u, _ := m["url"].(string); u != "" {
			downloadStarted := nowMs()
			du, err := downloadAsDataURL(u, mimeType)
			if err != nil {
				return nil, nil, nil, nil, endpoint, timings, err
			}
			images = append(images, du)
			timings = append(timings, TaskTiming{Key: fmt.Sprintf("image_fetch_%d", len(images)), Label: fmt.Sprintf("获取图片 #%d", len(images)), Duration: nowMs() - downloadStarted, Detail: u})
		}
		rp, _ := m["revised_prompt"].(string)
		revised = append(revised, rp)
	}
	return images, pickActual(payload), nil, revised, endpoint, timings, nil
}

func (s *Server) uploadToCOS(b *BucketConfig, taskID string, idx int, dataURL string) (string, string, error) {
	u, err := url.Parse(cosBucketURL(b))
	if err != nil {
		return "", "", err
	}
	client := cos.NewClient(&cos.BaseURL{BucketURL: u}, &http.Client{Transport: &cos.AuthorizationTransport{SecretID: b.SecretID, SecretKey: b.SecretKey}})
	mimeType, raw, err := parseDataURL(dataURL)
	if err != nil {
		return "", "", err
	}
	exts, _ := mime.ExtensionsByType(mimeType)
	ext := ".png"
	if len(exts) > 0 {
		ext = exts[0]
	}
	prefix := strings.Trim(strings.TrimSpace(b.PathPrefix), "/")
	key := fmt.Sprintf("%s/%s-%d%s", prefix, taskID, idx+1, ext)
	key = strings.TrimPrefix(key, "/")
	_, err = client.Object.Put(contextTODO(), key, bytes.NewReader(raw), &cos.ObjectPutOptions{ObjectPutHeaderOptions: &cos.ObjectPutHeaderOptions{ContentType: mimeType}})
	if err != nil {
		return "", "", err
	}
	expire := time.Duration(b.TempURLMinutes) * time.Minute
	if expire <= 0 {
		expire = time.Hour
	}
	presigned, err := client.Object.GetPresignedURL(contextTODO(), http.MethodGet, key, b.SecretID, b.SecretKey, expire, nil)
	if err != nil {
		return "", "", err
	}
	return presigned.String(), key, nil
}

func contextTODO() context.Context { return context.Background() }

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func nowMs() int64 { return time.Now().UnixMilli() }

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func validUsername(v string) bool {
	return regexp.MustCompile(`^[a-zA-Z0-9_\-.]{3,32}$`).MatchString(v)
}

func hashPassword(password string) string {
	salt := randomHex(16)
	mac := hmac.New(sha256.New, []byte(salt))
	mac.Write([]byte(password))
	return salt + ":" + hex.EncodeToString(mac.Sum(nil))
}

func checkPassword(password, stored string) bool {
	parts := strings.Split(stored, ":")
	if len(parts) != 2 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(parts[0]))
	mac.Write([]byte(password))
	return hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(parts[1]))
}

func ensureAdminKey(dataDir string) (string, error) {
	masterPath := filepath.Join(dataDir, "server.key")
	master, err := os.ReadFile(masterPath)
	if errors.Is(err, os.ErrNotExist) {
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return "", err
		}
		master = []byte(base64.StdEncoding.EncodeToString(key))
		if err := os.WriteFile(masterPath, master, 0o600); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	adminPath := filepath.Join(dataDir, "admin-key.enc")
	blob, err := os.ReadFile(adminPath)
	if errors.Is(err, os.ErrNotExist) {
		plain := randomHex(18)
		enc, err := encryptString(strings.TrimSpace(string(master)), plain)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(adminPath, []byte(enc), 0o600); err != nil {
			return "", err
		}
		log.Printf("IMPORTANT: encrypted admin key saved to %s; keep ./data mounted to persist it", adminPath)
		return plain, nil
	}
	if err != nil {
		return "", err
	}
	return decryptString(strings.TrimSpace(string(master)), strings.TrimSpace(string(blob)))
}

func encryptString(master, plain string) (string, error) {
	key, err := base64.StdEncoding.DecodeString(master)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := append(nonce, gcm.Seal(nil, nonce, []byte(plain), nil)...)
	return base64.StdEncoding.EncodeToString(out), nil
}

func decryptString(master, enc string) (string, error) {
	key, err := base64.StdEncoding.DecodeString(master)
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("invalid admin key file")
	}
	nonce, data := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	plain, err := gcm.Open(nil, nonce, data, nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func deriveCookieKey(dataDir string) []byte {
	b, err := os.ReadFile(filepath.Join(dataDir, "server.key"))
	if err != nil {
		b = []byte("fallback-cookie-key")
	}
	sum := sha256.Sum256(bytes.TrimSpace(b))
	return sum[:]
}

func (s *Server) signSession(sess *Session) string {
	payload := fmt.Sprintf("%s|%s|%s|%d", sess.UserID, sess.Username, sess.Role, time.Now().Add(30*24*time.Hour).Unix())
	mac := hmac.New(sha256.New, s.cookieKey)
	_, _ = mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))
	return base64.RawURLEncoding.EncodeToString([]byte(payload + "|" + sig))
}

func (s *Server) verifySignedSession(value string) (*Session, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return nil, false
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 5 {
		return nil, false
	}
	payload := strings.Join(parts[:4], "|")
	mac := hmac.New(sha256.New, s.cookieKey)
	_, _ = mac.Write([]byte(payload))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(parts[4])) {
		return nil, false
	}
	var exp int64
	if _, err := fmt.Sscanf(parts[3], "%d", &exp); err != nil || exp < time.Now().Unix() {
		return nil, false
	}
	if parts[2] != "admin" {
		state := s.store.snapshot()
		u := state.Users[parts[0]]
		if u == nil || u.Disabled || u.Banned {
			return nil, false
		}
	}
	sess := s.sessions.create(parts[0], parts[1], parts[2])
	return sess, true
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(io.LimitReader(r.Body, 600<<20)).Decode(v); err != nil {
		httpError(w, 400, "请求 JSON 无效")
		return false
	}
	return true
}

func httpError(w http.ResponseWriter, code int, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func methodNotAllowed(w http.ResponseWriter) {
	httpError(w, http.StatusMethodNotAllowed, "method not allowed")
}

func (s *Server) setSessionCookie(w http.ResponseWriter, sess *Session) {
	value := s.signSession(sess)
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/", MaxAge: 86400 * 30, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func (s *Server) sessionFromRequest(r *http.Request) (*Session, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil || c.Value == "" {
		return nil, false
	}
	if sess, ok := s.sessions.get(c.Value); ok {
		return sess, true
	}
	return s.verifySignedSession(c.Value)
}

func (s *Server) requireUser(next func(http.ResponseWriter, *http.Request, *Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := s.sessionFromRequest(r)
		if !ok {
			httpError(w, 401, "请先登录")
			return
		}
		next(w, r, sess)
	}
}

func (s *Server) requireAdmin(next func(http.ResponseWriter, *http.Request, *Session)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := s.sessionFromRequest(r)
		if !ok || sess.Role != "admin" {
			httpError(w, 403, "需要管理员登录")
			return
		}
		next(w, r, sess)
	}
}

func (s *Server) publicCurrentUser(u *User, role string) map[string]any {
	return map[string]any{"id": u.ID, "username": u.Username, "role": role, "quotaTotal": u.QuotaTotal, "quotaUsed": u.QuotaUsed, "quotaRemaining": max(0, u.QuotaTotal-u.QuotaUsed), "allowDirect": u.AllowDirect, "allowBucket": u.AllowBucket}
}

func (s *Server) adminUsers() []publicUser {
	state := s.store.snapshot()
	online := s.sessions.onlineUserIDs()
	running := map[string]int{}
	for _, t := range state.Tasks {
		if t.Status == "running" {
			running[t.UserID]++
		}
	}
	users := []publicUser{}
	for _, u := range state.Users {
		users = append(users, publicUser{ID: u.ID, Username: u.Username, Disabled: u.Disabled, Banned: u.Banned, QuotaTotal: u.QuotaTotal, QuotaUsed: u.QuotaUsed, QuotaRemaining: max(0, u.QuotaTotal-u.QuotaUsed), AllowDirect: u.AllowDirect, AllowBucket: u.AllowBucket, CreatedAt: u.CreatedAt, LastSeenAt: u.LastSeenAt, Online: online[u.ID], RunningTasks: running[u.ID]})
	}
	sort.Slice(users, func(i, j int) bool { return users[i].CreatedAt > users[j].CreatedAt })
	return users
}

func (s *Server) adminUser(id string) (publicUser, bool) {
	state := s.store.snapshot()
	u := state.Users[id]
	if u == nil {
		return publicUser{}, false
	}
	online := s.sessions.onlineUserIDs()
	runningTasks := 0
	for _, t := range state.Tasks {
		if t.UserID == id && t.Status == "running" {
			runningTasks++
		}
	}
	return publicUser{ID: u.ID, Username: u.Username, Disabled: u.Disabled, Banned: u.Banned, QuotaTotal: u.QuotaTotal, QuotaUsed: u.QuotaUsed, QuotaRemaining: max(0, u.QuotaTotal-u.QuotaUsed), AllowDirect: u.AllowDirect, AllowBucket: u.AllowBucket, CreatedAt: u.CreatedAt, LastSeenAt: u.LastSeenAt, Online: online[u.ID], RunningTasks: runningTasks}, true
}

func sanitizeTaskForUser(t *GenerationTask) *GenerationTask {
	cp := *t
	if cp.Status == "error" {
		cp.Error = sanitizeError(cp.Error, "")
	}
	return &cp
}

func sanitizeError(msg, baseURL string) string {
	if baseURL != "" {
		msg = strings.ReplaceAll(msg, baseURL, "[upstream]")
	}
	msg = regexp.MustCompile(`https?://[^\s"']+`).ReplaceAllString(msg, "[url]")
	msg = regexp.MustCompile(`sk-[A-Za-z0-9_\-]+`).ReplaceAllString(msg, "[api-key]")
	return msg
}

func maskSecret(v string) string {
	if v == "" {
		return ""
	}
	return "********"
}

func upstreamEndpoint(baseURL, path string) (string, error) {
	baseURL = strings.TrimSpace(baseURL)
	if baseURL == "" {
		return "", errors.New("请填写上游 API URL")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("上游 API URL 格式不正确")
	}
	base := strings.TrimRight(baseURL, "/")
	return base + path, nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func displayMode(mode string) string {
	if mode == "bucket" {
		return "存储桶"
	}
	return "直传"
}

func displayBool(v bool) string {
	if v {
		return "开启"
	}
	return "关闭"
}

func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case string:
		var x int
		fmt.Sscanf(n, "%d", &x)
		return x
	default:
		return 0
	}
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	default:
		return 0
	}
}

func pickActual(payload map[string]any) map[string]any {
	out := map[string]any{}
	for _, k := range []string{"size", "quality", "output_format", "output_compression", "moderation", "n"} {
		if v, ok := payload[k]; ok {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func writeFormField(mw *multipart.Writer, k string, v string) {
	if v != "" && v != "<nil>" {
		_ = mw.WriteField(k, v)
	}
}

func addDataURLFile(mw *multipart.Writer, field, filename, dataURL string) {
	mimeType, raw, err := parseDataURL(dataURL)
	if err != nil {
		return
	}
	part, err := mw.CreatePart(textprotoMIMEHeader(map[string]string{"Content-Disposition": fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, filename), "Content-Type": mimeType}))
	if err == nil {
		_, _ = part.Write(raw)
	}
}

func textprotoMIMEHeader(m map[string]string) textproto.MIMEHeader {
	h := textproto.MIMEHeader{}
	for k, v := range m {
		h.Set(k, v)
	}
	return h
}

func parseDataURL(dataURL string) (string, []byte, error) {
	if !strings.HasPrefix(dataURL, "data:") {
		return "", nil, errors.New("invalid data url")
	}
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 {
		return "", nil, errors.New("invalid data url")
	}
	meta := strings.TrimPrefix(parts[0], "data:")
	mimeType := strings.Split(meta, ";")[0]
	if mimeType == "" {
		mimeType = "image/png"
	}
	raw, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", nil, err
	}
	return mimeType, raw, nil
}

func downloadAsDataURL(src, fallbackMime string) (string, error) {
	resp, err := http.Get(src)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("图片 URL 下载失败：HTTP %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 200<<20))
	if err != nil {
		return "", err
	}
	mimeType := resp.Header.Get("Content-Type")
	if mimeType == "" {
		mimeType = fallbackMime
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
}

func firstBucket(buckets map[string]*BucketConfig) *BucketConfig {
	for _, b := range buckets {
		return b
	}
	return nil
}

func normalizeBucketConfig(req *BucketConfig) error {
	req.Name = strings.TrimSpace(req.Name)
	req.Region = strings.TrimSpace(req.Region)
	req.Bucket = strings.TrimSpace(req.Bucket)
	req.SecretID = strings.TrimSpace(req.SecretID)
	req.PathPrefix = strings.Trim(strings.TrimSpace(req.PathPrefix), "/")
	if req.Region == "" || req.Bucket == "" || req.SecretID == "" || req.SecretKey == "" {
		return errors.New("请填写 COS Region、Bucket、SecretId、SecretKey")
	}
	if req.TempURLMinutes <= 0 {
		req.TempURLMinutes = 60
	}
	if req.Name == "" {
		req.Name = req.Bucket
	}
	return nil
}

func cosBucketURL(b *BucketConfig) string {
	return fmt.Sprintf("https://%s.cos.%s.myqcloud.com", strings.TrimSpace(b.Bucket), strings.TrimSpace(b.Region))
}

func (s *Server) countBucketImages(b *BucketConfig) int {
	u, err := url.Parse(cosBucketURL(b))
	if err != nil {
		return 0
	}
	client := cos.NewClient(&cos.BaseURL{BucketURL: u}, &http.Client{Timeout: 3 * time.Second, Transport: &cos.AuthorizationTransport{SecretID: b.SecretID, SecretKey: b.SecretKey}})
	prefix := strings.Trim(strings.TrimSpace(b.PathPrefix), "/")
	if prefix != "" {
		prefix += "/"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	res, _, err := client.Bucket.Get(ctx, &cos.BucketGetOptions{Prefix: prefix, MaxKeys: 1000})
	if err != nil {
		return 0
	}
	count := 0
	for _, obj := range res.Contents {
		if strings.HasPrefix(obj.Key, prefix) {
			count++
		}
	}
	return count
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	path := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	servedPath := path
	if path == "." {
		path = "index.html"
		servedPath = path
	}
	full := filepath.Join(s.staticDir, path)
	if st, err := os.Stat(full); err != nil || st.IsDir() {
		full = filepath.Join(s.staticDir, "index.html")
		servedPath = "index.html"
	}
	setStaticCacheHeaders(w, servedPath)
	http.ServeFile(w, r, full)
}

func setStaticCacheHeaders(w http.ResponseWriter, path string) {
	name := strings.ToLower(filepath.Base(path))
	ext := strings.ToLower(filepath.Ext(path))
	if name == "index.html" || name == "sw.js" || name == "manifest.webmanifest" || ext == ".html" {
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		return
	}
	if strings.HasPrefix(strings.TrimPrefix(path, string(filepath.Separator)), "assets") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}

type releaseInfo struct {
	TagName string         `json:"tag_name"`
	Name    string         `json:"name"`
	Assets  []releaseAsset `json:"assets"`
}

type releaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type updateCheckResponse struct {
	Backend  componentUpdate `json:"backend"`
	Frontend componentUpdate `json:"frontend"`
}

type componentUpdate struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
	AssetName       string `json:"assetName,omitempty"`
}

func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	release, err := fetchLatestRelease()
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	backendLatest := assetVersion(release.Assets, "backend-version.txt")
	frontendLatest := assetVersion(release.Assets, "frontend-version.txt")
	backendAsset := backendAssetName()
	frontendAsset := frontendAssetName(frontendLatest)
	writeJSON(w, updateCheckResponse{
		Backend:  componentUpdate{CurrentVersion: backendVersion, LatestVersion: backendLatest, UpdateAvailable: backendLatest != "" && backendLatest != backendVersion && findAsset(release.Assets, backendAsset) != nil, AssetName: backendAsset},
		Frontend: componentUpdate{CurrentVersion: frontendVersion, LatestVersion: frontendLatest, UpdateAvailable: frontendLatest != "" && frontendLatest != frontendVersion && findAsset(release.Assets, frontendAsset) != nil, AssetName: frontendAsset},
	})
}

func (s *Server) handleUpdateBackend(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !updateMu.TryLock() {
		httpError(w, 409, "已有更新任务正在执行")
		return
	}
	defer updateMu.Unlock()
	release, err := fetchLatestRelease()
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	asset := findAsset(release.Assets, backendAssetName())
	if asset == nil {
		httpError(w, 404, "未找到当前平台后端二进制资产")
		return
	}
	archivePath, err := downloadReleaseAsset(*asset, s.dataDir)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer os.Remove(archivePath)
	if err := replaceExecutableFromZip(archivePath); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "message": "后端已更新，重启后生效", "needRestart": true})
}

func (s *Server) handleUpdateFrontend(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !updateMu.TryLock() {
		httpError(w, 409, "已有更新任务正在执行")
		return
	}
	defer updateMu.Unlock()
	release, err := fetchLatestRelease()
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	latest := assetVersion(release.Assets, "frontend-version.txt")
	asset := findAsset(release.Assets, frontendAssetName(latest))
	if asset == nil {
		httpError(w, 404, "未找到前端静态资源资产")
		return
	}
	archivePath, err := downloadReleaseAsset(*asset, s.dataDir)
	if err != nil {
		httpError(w, 502, err.Error())
		return
	}
	defer os.Remove(archivePath)
	if err := replaceStaticDistFromZip(archivePath, s.staticDir); err != nil {
		httpError(w, 500, err.Error())
		return
	}
	frontendVersion = latest
	writeJSON(w, map[string]any{"ok": true, "message": "前端已更新，刷新页面后生效", "needRestart": false})
}

func (s *Server) handleRestart(w http.ResponseWriter, r *http.Request, sess *Session) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	writeJSON(w, map[string]any{"ok": true, "message": "服务即将重启"})
	go func() { time.Sleep(500 * time.Millisecond); os.Exit(0) }()
}

func fetchLatestRelease() (*releaseInfo, error) {
	url := "https://api.github.com/repos/" + releaseRepo + "/releases/latest"
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	req.Header.Set("User-Agent", "gpt-image-playground-distribution-updater")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("GitHub Release 查询失败：HTTP %d %s", resp.StatusCode, string(body))
	}
	var release releaseInfo
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, err
	}
	return &release, nil
}

func backendAssetName() string {
	return fmt.Sprintf("gip-server_%s_%s_%s.zip", backendVersionOrLatest(), runtime.GOOS, runtime.GOARCH)
}

func frontendAssetName(version string) string {
	if version == "" {
		version = frontendVersion
	}
	return fmt.Sprintf("frontend-dist_%s.zip", version)
}

func backendVersionOrLatest() string { return "LATEST" }

func findAsset(assets []releaseAsset, name string) *releaseAsset {
	if strings.Contains(name, "LATEST") {
		for i := range assets {
			if strings.HasPrefix(assets[i].Name, "gip-server_") && strings.Contains(assets[i].Name, "_"+runtime.GOOS+"_"+runtime.GOARCH) {
				return &assets[i]
			}
		}
		return nil
	}
	for i := range assets {
		if assets[i].Name == name {
			return &assets[i]
		}
	}
	return nil
}

func assetVersion(assets []releaseAsset, name string) string {
	asset := findAsset(assets, name)
	if asset == nil {
		return ""
	}
	path, err := downloadReleaseAsset(*asset, os.TempDir())
	if err != nil {
		return ""
	}
	defer os.Remove(path)
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func downloadReleaseAsset(asset releaseAsset, dir string) (string, error) {
	if err := validateDownloadURL(asset.BrowserDownloadURL); err != nil {
		return "", err
	}
	resp, err := http.Get(asset.BrowserDownloadURL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("下载 %s 失败：HTTP %d", asset.Name, resp.StatusCode)
	}
	path := filepath.Join(dir, randomHex(8)+"-"+filepath.Base(asset.Name))
	out, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer out.Close()
	_, err = io.Copy(out, io.LimitReader(resp.Body, 600<<20))
	return path, err
}

func validateDownloadURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "https" {
		return errors.New("更新资源必须使用 HTTPS")
	}
	allowed := map[string]bool{"github.com": true, "objects.githubusercontent.com": true, "release-assets.githubusercontent.com": true}
	if !allowed[strings.ToLower(u.Hostname())] {
		return fmt.Errorf("不允许的下载域名：%s", u.Hostname())
	}
	return nil
}

func replaceExecutableFromZip(path string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if strings.HasSuffix(path, ".zip") {
		return replaceExecutableFromZipArchive(path, exe)
	}
	return errors.New("当前仅支持 zip 后端资产更新")
}

func replaceExecutableFromZipArchive(path string, exe string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	var target *zip.File
	for _, f := range zr.File {
		if !f.FileInfo().IsDir() && (filepath.Base(f.Name) == "gip-server" || filepath.Base(f.Name) == "gip-server.exe") {
			target = f
			break
		}
	}
	if target == nil {
		return errors.New("压缩包中未找到后端二进制")
	}
	rc, err := target.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	tmp := exe + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, io.LimitReader(rc, 200<<20)); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	backup := exe + ".backup"
	_ = os.Remove(backup)
	if err := os.Rename(exe, backup); err != nil {
		return err
	}
	if err := os.Rename(tmp, exe); err != nil {
		_ = os.Rename(backup, exe)
		return err
	}
	return nil
}

func replaceStaticDistFromZip(path string, staticDir string) error {
	if staticDir == "" {
		return errors.New("STATIC_DIR 为空，无法更新前端")
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	parent := filepath.Dir(staticDir)
	tmp := filepath.Join(parent, ".dist-new-"+randomHex(4))
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		clean := filepath.Clean(f.Name)
		clean = strings.TrimPrefix(filepath.ToSlash(clean), "dist/")
		if clean == "." || strings.HasPrefix(clean, "../") || strings.Contains(clean, "/../") {
			return errors.New("前端压缩包路径不安全")
		}
		dst := filepath.Join(tmp, filepath.FromSlash(clean))
		if !strings.HasPrefix(filepath.Clean(dst), filepath.Clean(tmp)) {
			return errors.New("前端压缩包路径越界")
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(dst)
		if err != nil {
			rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, io.LimitReader(rc, 200<<20))
		closeErr := out.Close()
		rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	backup := staticDir + ".backup"
	_ = os.RemoveAll(backup)
	if _, err := os.Stat(staticDir); err == nil {
		if err := os.Rename(staticDir, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, staticDir); err != nil {
		_ = os.Rename(backup, staticDir)
		return err
	}
	return nil
}
