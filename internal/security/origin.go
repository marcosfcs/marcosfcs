package security

import (
	"encoding/json"
	"net/http"
	"net/url"
)

// IsSameOrigin espelha server.js:isSameOrigin — aprova requisições
// same-origin, ferramentas de linha de comando e navegações diretas (sem
// Origin/Referer), e reprova só quando há um Origin/Referer de origem
// EXTERNA explícita. Não é fronteira de autenticação, é defesa contra
// CSRF/abuso cross-origin num app single-user local.
func IsSameOrigin(r *http.Request) bool {
	src := r.Header.Get("Origin")
	if src == "" {
		src = r.Header.Get("Referer")
	}
	if src == "" {
		return true
	}
	u, err := url.Parse(src)
	if err != nil {
		return false
	}
	return u.Host == r.Host
}

// DenyCrossOrigin escreve a mesma resposta 403 JSON de server.js:denyCrossOrigin.
func DenyCrossOrigin(w http.ResponseWriter) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	json.NewEncoder(w).Encode(map[string]string{
		"error": "Requisição cross-origin recusada para este endpoint.",
	})
}

// HandlePreflight responde OPTIONS ecoando a Origin só quando ela é a
// própria (mesmo host) — igual a server.js:handlePreflight. Nunca anuncia
// access-control-allow-origin:* global.
func HandlePreflight(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("access-control-allow-methods", "GET, HEAD, OPTIONS, POST")
	h.Set("access-control-allow-headers", "content-type")
	h.Set("vary", "Origin")
	if origin := r.Header.Get("Origin"); origin != "" && IsSameOrigin(r) {
		h.Set("access-control-allow-origin", origin)
	}
	w.WriteHeader(http.StatusNoContent)
}
