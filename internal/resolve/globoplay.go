// Resolução de URL do Globoplay achando a URL do manifest HLS/DASH REAL que
// o player da página busca via JS — mesmo racional de
// server.js:handleResolveGloboplay. Diferente do YouTube, isso não está
// embutido estaticamente no HTML nem o yt-dlp sabe extrair, só aparece numa
// requisição de rede depois que a página carrega e o player inicializa. Por
// isso a única forma é um navegador de verdade: aqui, via
// github.com/mxschmitt/playwright-go, que fala CDP diretamente (não precisa
// mais do processo playwright/Node em tempo de execução — só no setup
// inicial, ver Install em cmd/server).
//
// O conteúdo ao vivo exige login — reaproveita a MESMA sessão salva
// (storageState.json) já produzida por scripts/globoplay-login.js, tanto na
// versão Node quanto na versão Go dele: o formato do arquivo não muda,
// então uma sessão já salva continua funcionando sem refazer o login.
package resolve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/mxschmitt/playwright-go"
)

var globoplayHostsRe = regexp.MustCompile(`(?i)^(?:www\.)?globoplay\.globo\.com$`)
var manifestURLRe = regexp.MustCompile(`(?i)\.(m3u8|mpd)(\?|$)`)
var loginRedirectRe = regexp.MustCompile(`(?i)login|entrar|signin`)

const globoplayResolveTimeout = 20 * time.Second

// GloboplayResolver mantém o guard de single-flight (equivalente ao
// `globoplayResolving` do server.js): cada resolução lança um Chromium
// headless inteiro — caro. Sem isto, chamadas em rajada spawnariam
// navegadores até esgotar CPU/RAM da máquina. atomic.Bool porque, ao
// contrário do event loop do Node, o net/http do Go atende requisições
// concorrentemente por padrão.
type GloboplayResolver struct {
	SessionPath string
	resolving   atomic.Bool
}

func writeGPError(w http.ResponseWriter, status int, payload map[string]any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

// Handler implementa GET /resolve-globoplay?url=<globoplay-url> — mesmo
// formato de resposta de server.js:handleResolveGloboplay.
func (g *GloboplayResolver) Handler(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || !globoplayHostsRe.MatchString(u.Hostname()) {
		writeGPError(w, http.StatusBadRequest, map[string]any{
			"error": "URL do Globoplay inválida ou host não suportado.",
		})
		return
	}

	if !g.resolving.CompareAndSwap(false, true) {
		writeGPError(w, http.StatusTooManyRequests, map[string]any{
			"error": "Já há uma resolução do Globoplay em andamento. Aguarde alguns segundos e tente de novo.",
			"code":  "BUSY",
		})
		return
	}
	defer g.resolving.Store(false)

	if _, err := os.Stat(g.SessionPath); err != nil {
		writeGPError(w, http.StatusPreconditionFailed, map[string]any{
			"error": `Nenhuma sessão do Globoplay salva. Rode "go run ./cmd/globoplay-login" uma vez ` +
				`(faz login manual num navegador visível) antes de inspecionar URLs do Globoplay.`,
			"code": "NO_SESSION",
		})
		return
	}

	pw, err := playwright.Run()
	if err != nil {
		writeGPError(w, http.StatusNotImplemented, map[string]any{
			"error": "Playwright não está instalado. Rode a instalação do driver/Chromium " +
				"(ver README) na máquina que roda o servidor.",
			"code": "NO_PLAYWRIGHT",
		})
		return
	}
	defer pw.Stop()

	headless := true
	launchOpts := playwright.BrowserTypeLaunchOptions{Headless: &headless}
	if p := os.Getenv("PLAYWRIGHT_CHROMIUM_PATH"); p != "" {
		launchOpts.ExecutablePath = &p
	}
	browser, err := pw.Chromium.Launch(launchOpts)
	if err != nil {
		writeGPError(w, http.StatusInternalServerError, map[string]any{
			"error": "Falha ao iniciar o Chromium: " + err.Error(),
		})
		return
	}
	defer browser.Close()

	ctx, err := browser.NewContext(playwright.BrowserNewContextOptions{StorageStatePath: &g.SessionPath})
	if err != nil {
		writeGPError(w, http.StatusInternalServerError, map[string]any{"error": "Falha ao criar contexto: " + err.Error()})
		return
	}
	page, err := ctx.NewPage()
	if err != nil {
		writeGPError(w, http.StatusInternalServerError, map[string]any{"error": "Falha ao criar página: " + err.Error()})
		return
	}

	manifestURL, code, err := waitForManifestRequest(page, raw)
	if err != nil {
		switch code {
		case "SESSION_EXPIRED":
			writeGPError(w, http.StatusUnauthorized, map[string]any{
				"error": `Sessão do Globoplay expirada (redirecionou para login). Rode o login novamente.`,
				"code":  "SESSION_EXPIRED",
			})
		case "TIMEOUT":
			writeGPError(w, http.StatusGatewayTimeout, map[string]any{
				"error": "Não encontrou a URL do manifest a tempo — a página pode ter mudado de estrutura, ou o conteúdo pode estar bloqueado/indisponível.",
				"code":  "TIMEOUT",
			})
		default:
			writeGPError(w, http.StatusInternalServerError, map[string]any{"error": "Falha ao resolver via Playwright: " + err.Error()})
		}
		return
	}

	typ := "hls"
	if regexp.MustCompile(`(?i)\.mpd`).MatchString(manifestURL) {
		typ = "dash"
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"manifestUrl": manifestURL, "type": typ})
}

// waitForManifestRequest escuta as requisições da página até a primeira que
// bater .m3u8/.mpd, com timeout — mesma lógica de
// server.js:handleResolveGloboplay (page.on('request', ...) + Promise com
// timeout + detecção de redirect de login).
func waitForManifestRequest(page playwright.Page, targetURL string) (manifestURL string, code string, err error) {
	found := make(chan string, 1)
	page.OnRequest(func(req playwright.Request) {
		if manifestURLRe.MatchString(req.URL()) {
			select {
			case found <- req.URL():
			default:
			}
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), globoplayResolveTimeout)
	defer cancel()

	navDone := make(chan struct{})
	go func() {
		timeoutMs := float64(globoplayResolveTimeout.Milliseconds())
		waitUntil := playwright.WaitUntilStateDomcontentloaded
		page.Goto(targetURL, playwright.PageGotoOptions{Timeout: &timeoutMs, WaitUntil: waitUntil})
		close(navDone)
	}()

	select {
	case m := <-found:
		return m, "", nil
	case <-navDone:
		// Navegação terminou antes de qualquer manifest aparecer — sessão
		// expirada normalmente redireciona pra uma URL de login.
		finalURL := page.URL()
		if loginRedirectRe.MatchString(finalURL) && !manifestURLRe.MatchString(finalURL) {
			return "", "SESSION_EXPIRED", errStr("sessão expirada")
		}
		// Ainda pode chegar depois da navegação (scripts assíncronos) — espera o resto do timeout.
		select {
		case m := <-found:
			return m, "", nil
		case <-ctx.Done():
			return "", "TIMEOUT", errStr("timeout")
		}
	case <-ctx.Done():
		return "", "TIMEOUT", errStr("timeout")
	}
}

type simpleError string

func (e simpleError) Error() string { return string(e) }
func errStr(s string) error         { return simpleError(s) }
