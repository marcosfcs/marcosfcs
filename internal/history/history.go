// Package history implementa o histórico persistente de inspeções — mesma
// função de server.js (node:sqlite), aqui via modernc.org/sqlite (driver
// SQLite 100% Go, sem cgo — mantém o binário final estático e fácil de
// cross-compilar, ao contrário de mattn/go-sqlite3 que embrulha a libsqlite3
// em C).
package history

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
)

// MaxRows é o teto de linhas guardadas — defesa em profundidade contra DoS
// de disco, igual a server.js:HISTORY_MAX_ROWS. É var (não const) só para
// os testes conseguirem reduzi-lo e verificar a poda sem inserir 500+ linhas.
var MaxRows = 500

// bodyMaxBytes limita o corpo do POST — é só o resumo estático, não a
// telemetria inteira (server.js:HISTORY_BODY_MAX_BYTES).
const bodyMaxBytes = 2 * 1024 * 1024

// DataDir resolve o mesmo local usado pelo server.js: $HOME/.stream-inspector
// por padrão, ou STREAM_INSPECTOR_DATA_DIR — de propósito fora do
// repositório, pra sobreviver a qualquer novo `git clone`.
func DataDir() (string, error) {
	if v := os.Getenv("STREAM_INSPECTOR_DATA_DIR"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".stream-inspector"), nil
}

// Store envolve o *sql.DB com o schema já garantido.
type Store struct {
	db  *sql.DB
	err error // motivo de estar indisponível, se db == nil (mesmo padrão de honestidade do server.js)
}

// Open abre (criando se preciso) o banco em <DataDir>/history.sqlite. Se
// falhar, Store.err fica preenchido e todo handler responde 501 explicando
// por quê — mesmo padrão usado para yt-dlp/WebCodecs ausentes.
func Open() *Store {
	dir, err := DataDir()
	if err != nil {
		return &Store{err: err}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return &Store{err: err}
	}
	db, err := sql.Open("sqlite", filepath.Join(dir, "history.sqlite"))
	if err != nil {
		return &Store{err: err}
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS inspections (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts INTEGER NOT NULL,
			url TEXT NOT NULL,
			protocol TEXT,
			live INTEGER,
			video_variants INTEGER,
			audio_tracks INTEGER,
			hdr TEXT,
			drm TEXT,
			summary_json TEXT NOT NULL
		)
	`); err != nil {
		db.Close()
		return &Store{err: err}
	}
	return &Store{db: db}
}

type saveRequest struct {
	URL           string          `json:"url"`
	Protocol      string          `json:"protocol"`
	Live          bool            `json:"live"`
	VideoVariants *int            `json:"videoVariants"`
	AudioTracks   *int            `json:"audioTracks"`
	HDR           string          `json:"hdr"`
	DRM           string          `json:"drm"`
	Summary       json.RawMessage `json:"summary"`
}

type item struct {
	ID            int64           `json:"id"`
	TS            int64           `json:"ts"`
	URL           string          `json:"url"`
	Protocol      *string         `json:"protocol"`
	Live          bool            `json:"live"`
	VideoVariants *int            `json:"videoVariants"`
	AudioTracks   *int            `json:"audioTracks"`
	HDR           *string         `json:"hdr"`
	DRM           *string         `json:"drm"`
	Summary       json.RawMessage `json:"summary"`
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// SaveHandler implementa POST /api/history — mesmo formato de server.js:handleHistorySave.
func (s *Store) SaveHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSONError(w, http.StatusNotImplemented, "Histórico indisponível: "+unavailableReason(s.err))
		return
	}
	var body saveRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, bodyMaxBytes))
	if err := dec.Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "JSON inválido.")
		return
	}
	if body.URL == "" || len(body.Summary) == 0 {
		writeJSONError(w, http.StatusBadRequest, "Campos obrigatórios: url, summary.")
		return
	}
	url := body.URL
	if len(url) > 2000 {
		url = url[:2000]
	}

	tx, err := s.db.Begin()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Falha ao salvar no histórico: "+err.Error())
		return
	}
	defer tx.Rollback()

	res, err := tx.Exec(`
		INSERT INTO inspections (ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, nowMillis(), url, nullIfEmpty(body.Protocol), boolToInt(body.Live),
		body.VideoVariants, body.AudioTracks, nullIfEmpty(body.HDR), nullIfEmpty(body.DRM), string(body.Summary))
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Falha ao salvar no histórico: "+err.Error())
		return
	}
	id, _ := res.LastInsertId()

	// poda pras N mais recentes — dentro da MESMA transação do insert, pra
	// não intercalar com outro insert concorrente (ver nota de concorrência
	// no plano: isto não era um problema no Node, single-threaded).
	if _, err := tx.Exec(`
		DELETE FROM inspections WHERE id NOT IN (
			SELECT id FROM inspections ORDER BY ts DESC, id DESC LIMIT ?
		)
	`, MaxRows); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Falha ao salvar no histórico: "+err.Error())
		return
	}
	if err := tx.Commit(); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Falha ao salvar no histórico: "+err.Error())
		return
	}

	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": id})
}

// ListHandler implementa GET /api/history?limit=N — mesmo formato de server.js:handleHistoryList.
func (s *Store) ListHandler(w http.ResponseWriter, r *http.Request) {
	if s.db == nil {
		writeJSONError(w, http.StatusNotImplemented, "Histórico indisponível: "+unavailableReason(s.err))
		return
	}
	limit := 20
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil {
		limit = v
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}

	rows, err := s.db.Query(`
		SELECT id, ts, url, protocol, live, video_variants, audio_tracks, hdr, drm, summary_json
		FROM inspections ORDER BY ts DESC LIMIT ?
	`, limit)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "Falha ao ler histórico: "+err.Error())
		return
	}
	defer rows.Close()

	items := []item{}
	for rows.Next() {
		var it item
		var liveInt int
		var summaryJSON string
		if err := rows.Scan(&it.ID, &it.TS, &it.URL, &it.Protocol, &liveInt,
			&it.VideoVariants, &it.AudioTracks, &it.HDR, &it.DRM, &summaryJSON); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "Falha ao ler histórico: "+err.Error())
			return
		}
		it.Live = liveInt != 0
		it.Summary = json.RawMessage(summaryJSON)
		items = append(items, it)
	}

	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"items": items})
}

func unavailableReason(err error) string {
	if err == nil {
		return "node:sqlite não carregado"
	}
	return err.Error()
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
