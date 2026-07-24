// Package proxy implementa a rota /p/<scheme>/<host>/<path>, que repassa
// requisições GET para o host informado — mesma função de server.js
// handleProxy/upstreamGet, com dois reforços estruturais que o Go permite
// de graça (ver comentários abaixo): HTTP_PROXY/HTTPS_PROXY/NO_PROXY via
// http.ProxyFromEnvironment (sem túnel CONNECT manual) e bloqueio de SSRF
// em duas camadas (DNS pré-requisição + net.Dialer.Control na conexão real).
package proxy

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"stream-inspector/internal/security"
)

const (
	maxRedirects     = 5
	manifestMaxBytes = 20 * 1024 * 1024 // manifests são pequenos; limite de segurança
	upstreamTimeout  = 30 * time.Second
	dialTimeout      = 10 * time.Second
)

// throttleKbps é lido/escrito concorrentemente por goroutines de requisição
// diferentes — ao contrário do event loop single-threaded do Node, aqui
// isso PRECISA ser atômico (ver nota de concorrência no plano).
var throttleKbps atomic.Int64

// SetThrottle e Throttle expõem o estado para o handler de /throttle.
func SetThrottle(kbps int64) { throttleKbps.Store(kbps) }
func Throttle() int64        { return throttleKbps.Load() }

var client = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment, // honra HTTP_PROXY/HTTPS_PROXY/NO_PROXY nativamente
		DialContext: (&net.Dialer{
			Timeout: dialTimeout,
			Control: security.DialControl, // bloqueia SSRF no momento da conexão real (dial direto)
		}).DialContext,
	},
	Timeout: upstreamTimeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirects {
			return fmt.Errorf("redirects em excesso")
		}
		// Checagem de SSRF por hostname (cobre o caso de proxy corporativo
		// configurado — ver comentário em security.IsBlockedTarget) a cada
		// hop de redirect, igual ao server.js (upstreamGet é recursivo e
		// rechecha isBlockedTarget em cada Location).
		if security.IsBlockedTarget(req.Context(), req.URL.Hostname()) {
			return fmt.Errorf("alvo interno/privado bloqueado no redirect")
		}
		return nil
	},
}

// passthroughHeaders espelha a allowlist de server.js:handleProxy — inclui
// identificação de CDN/edge e CMSD/CMCD-eco pro painel "CDN / edge".
var passthroughHeaders = []string{
	"content-length", "content-range", "accept-ranges",
	"x-cache", "x-served-by", "x-amz-cf-id", "x-amz-cf-pop", "cf-ray", "cf-cache-status",
	"via", "age", "server", "x-akamai-request-id", "fastly-debug-digest",
	"cmsd-static", "cmsd-dynamic",
}

var routeRe = regexp.MustCompile(`^/p/(https?)/([^/]+)(/.*)?$`)

// Handler implementa GET /p/<scheme>/<host>/<path...>?<query>.
func Handler(w http.ResponseWriter, r *http.Request) {
	m := routeRe.FindStringSubmatch(r.URL.Path)
	if m == nil {
		http.Error(w, "Rota de proxy: /p/<http|https>/<host>/<caminho>", http.StatusBadRequest)
		return
	}
	scheme, host, rest := m[1], m[2], m[3]
	if rest == "" {
		rest = "/"
	}
	targetURL := scheme + "://" + host + rest
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	upstream, finalURL, err := upstreamGet(r.Context(), targetURL, r.Header)
	if err != nil {
		status := statusFromErr(err)
		w.WriteHeader(status)
		fmt.Fprintf(w, "Erro ao buscar %s\n%s", targetURL, err)
		return
	}
	defer upstream.Body.Close()

	contentType := upstream.Header.Get("content-type")
	rewritable := isM3U8(finalURL, contentType) || isMPD(finalURL, contentType)

	// Sem access-control-allow-origin aqui de propósito — ver server.js:347-350:
	// o app é servido pela mesma origem deste servidor, e anunciar ACAO:*
	// transformaria o proxy num vetor de leitura cross-origin amplificado.
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("x-final-url", finalURL)
	if contentType != "" {
		w.Header().Set("content-type", contentType)
	}

	if !rewritable {
		for _, h := range passthroughHeaders {
			if v := upstream.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.WriteHeader(upstream.StatusCode)
		if kbps := throttleKbps.Load(); kbps > 0 {
			throttledCopy(w, upstream.Body)
		} else {
			io.Copy(w, upstream.Body)
		}
		return
	}

	// Manifest: bufferiza (com teto de tamanho), reescreve URLs absolutas e responde.
	body, err := io.ReadAll(io.LimitReader(upstream.Body, manifestMaxBytes+1))
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	if len(body) > manifestMaxBytes {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("Manifest excede o limite de tamanho"))
		return
	}
	text := string(body)
	if isM3U8(finalURL, contentType) {
		text = rewriteM3U8(text)
	} else {
		text = rewriteMPD(text)
	}
	w.WriteHeader(upstream.StatusCode)
	io.WriteString(w, text)
}

func statusFromErr(err error) int {
	if he, ok := err.(*httpStatusError); ok {
		return he.status
	}
	return http.StatusBadGateway
}

type httpStatusError struct {
	status int
	err    error
}

func (e *httpStatusError) Error() string { return e.err.Error() }

// upstreamGet faz o GET em targetURL, com bloqueio de SSRF prévio (por
// hostname) e seguindo redirects via o http.Client compartilhado (que já
// rechecha SSRF a cada hop em CheckRedirect, e honra HTTP(S)_PROXY nativamente).
func upstreamGet(ctx context.Context, targetURL string, clientHeaders http.Header) (*http.Response, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, "", &httpStatusError{http.StatusBadRequest, fmt.Errorf("URL inválida: %s", targetURL)}
	}
	if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
		return nil, "", &httpStatusError{http.StatusBadRequest, fmt.Errorf("apenas http/https são suportados")}
	}
	if security.IsBlockedTarget(ctx, req.URL.Hostname()) {
		return nil, "", &httpStatusError{http.StatusForbidden, fmt.Errorf(
			"alvo interno/privado bloqueado (defina ALLOW_PRIVATE_PROXY=1 só em rede confiável)")}
	}

	req.Header.Set("user-agent", firstNonEmpty(clientHeaders.Get("user-agent"), "stream-inspector/1.0"))
	req.Header.Set("accept", "*/*")
	req.Header.Set("accept-encoding", "identity") // simplifica reescrita de manifests
	if rng := clientHeaders.Get("range"); rng != "" {
		req.Header.Set("range", rng)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", &httpStatusError{http.StatusBadGateway, err}
	}
	return resp, resp.Request.URL.String(), nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// throttledCopy repassa src→dst respeitando o throttleKbps VIGENTE a cada
// chunk — igual a server.js:throttledPipe, mudar o limite no meio de uma
// entrega em andamento tem efeito imediato.
func throttledCopy(dst io.Writer, src io.Reader) {
	buf := make([]byte, 16*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
			if kbps := throttleKbps.Load(); kbps > 0 {
				bytesPerSec := float64(kbps*1000) / 8
				delay := time.Duration(float64(n) / bytesPerSec * float64(time.Second))
				time.Sleep(delay)
			}
		}
		if err != nil {
			return
		}
	}
}

/* ---------------------------------------------------------------- *
 * Detecção e reescrita de manifests (apenas URLs absolutas)
 * ---------------------------------------------------------------- */

var (
	m3u8ExtRe = regexp.MustCompile(`(?i)\.m3u8(\?|$)`)
	mpegurlRe = regexp.MustCompile(`(?i)mpegurl`)
	mpdExtRe  = regexp.MustCompile(`(?i)\.mpd(\?|$)`)
	dashXMLRe = regexp.MustCompile(`(?i)dash\+xml`)
	absURLRe  = regexp.MustCompile(`(?i)^https?://`)
	uriAttrRe = regexp.MustCompile(`URI="(https?://[^"]+)"`)
	baseURLRe = regexp.MustCompile(`(?i)(<BaseURL[^>]*>)\s*(https?://[^<\s]+)\s*(</BaseURL>)`)
	mpdAttrRe = regexp.MustCompile(`(?i)\b(media|initialization|sourceURL|xlink:href)="(https?://[^"]+)"`)
)

func isM3U8(finalURL, contentType string) bool {
	return m3u8ExtRe.MatchString(finalURL) || mpegurlRe.MatchString(contentType)
}

func isMPD(finalURL, contentType string) bool {
	return mpdExtRe.MatchString(finalURL) || dashXMLRe.MatchString(contentType)
}

func toProxyPath(absURL string) string {
	u, err := url.Parse(absURL)
	if err != nil {
		return absURL
	}
	path := "/p/" + u.Scheme + "/" + u.Host + u.Path
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return path
}

func rewriteM3U8(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		t := strings.TrimSpace(line)
		if t == "" {
			continue
		}
		if strings.HasPrefix(t, "#") {
			lines[i] = uriAttrRe.ReplaceAllStringFunc(line, func(m string) string {
				sub := uriAttrRe.FindStringSubmatch(m)
				return `URI="` + toProxyPath(sub[1]) + `"`
			})
			continue
		}
		if absURLRe.MatchString(t) {
			lines[i] = toProxyPath(t)
		}
		// URLs relativas resolvem sozinhas contra /p/... — não mexe.
	}
	return strings.Join(lines, "\n")
}

func rewriteMPD(text string) string {
	text = baseURLRe.ReplaceAllStringFunc(text, func(m string) string {
		sub := baseURLRe.FindStringSubmatch(m)
		return sub[1] + toProxyPath(sub[2]) + sub[3]
	})
	text = mpdAttrRe.ReplaceAllStringFunc(text, func(m string) string {
		sub := mpdAttrRe.FindStringSubmatch(m)
		return sub[1] + `="` + toProxyPath(sub[2]) + `"`
	})
	return text
}

/* ---------------------------------------------------------------- *
 * Endpoint /throttle
 * ---------------------------------------------------------------- */

// ThrottleHandler implementa GET /throttle?kbps=N — igual a server.js:handleThrottle.
func ThrottleHandler(w http.ResponseWriter, r *http.Request) {
	kbpsStr := r.URL.Query().Get("kbps")
	kbps, err := strconv.ParseInt(kbpsStr, 10, 64)
	if err != nil || kbps < 0 || kbps > 1000000 {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":"kbps deve estar entre 0 (sem limite) e 1000000"}`)
		return
	}
	throttleKbps.Store(kbps)
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	fmt.Fprintf(w, `{"throttleKbps":%d}`, kbps)
}
