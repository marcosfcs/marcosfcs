// Package security contém as guardas de SSRF e mesma-origem compartilhadas
// pelo proxy e pelos endpoints de resolução. Porta 1:1 das mesmas regras de
// server.js (isInternalIp/isBlockedTarget), com uma melhoria estrutural: em
// vez de resolver o DNS, checar, e SÓ DEPOIS conectar (janela de
// TOCTOU/DNS-rebinding), o bloqueio aqui roda dentro de net.Dialer.Control,
// que recebe o endereço exato do socket no momento em que ele está de fato
// sendo aberto — não há brecha entre "checou" e "conectou".
package security

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
)

// AllowPrivateProxy espelha ALLOW_PRIVATE_PROXY do server.js: desligado por
// padrão para o proxy não virar um SSRF drive-by; ligado conscientemente só
// em rede confiável (ex.: para proxiar streams de LAN).
var AllowPrivateProxy = os.Getenv("ALLOW_PRIVATE_PROXY") == "1"

// IsInternalIP reporta se ip cai numa faixa loopback/link-local/privada/ULA/
// CGNAT — mesmas faixas de server.js:isInternalIp. IPs malformados ou não
// reconhecíveis são tratados como bloqueados (fail-closed).
func IsInternalIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 127: // 127.0.0.0/8 loopback
			return true
		case v4[0] == 10: // 10.0.0.0/8 privado
			return true
		case v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31: // 172.16.0.0/12 privado
			return true
		case v4[0] == 192 && v4[1] == 168: // 192.168.0.0/16 privado
			return true
		case v4[0] == 169 && v4[1] == 254: // 169.254.0.0/16 link-local (metadata de nuvem)
			return true
		case v4[0] == 0: // 0.0.0.0/8
			return true
		case v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127: // 100.64.0.0/10 CGNAT
			return true
		default:
			return false
		}
	}
	// IPv6
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() {
		return true
	}
	if len(ip) == net.IPv6len && (ip[0] == 0xfc || ip[0] == 0xfd) { // fc00::/7 ULA
		return true
	}
	return false
}

// IsBlockedHostname trata nomes óbvios de loopback antes mesmo do DNS, igual
// ao server.js (localhost/*.localhost) — cobre o caso raro de um resolver
// que não devolveria 127.0.0.1 para esses nomes.
func IsBlockedHostname(host string) bool {
	if AllowPrivateProxy {
		return false
	}
	h := strings.ToLower(strings.Trim(host, "[]"))
	return h == "localhost" || strings.HasSuffix(h, ".localhost")
}

// DialControl tem a assinatura exigida por net.Dialer.Control — é passado
// diretamente como o Control do Dialer usado pelo http.Transport do proxy.
// Recebe o endereço já resolvido do socket prestes a abrir e recusa a
// conexão se cair numa faixa interna. Roda a cada tentativa de conexão,
// inclusive em redirects que o http.Client segue automaticamente — sem
// precisar reimplementar "checar de novo a cada hop" à mão como o
// server.js faz em upstreamGet.
func DialControl(network, address string, _ syscall.RawConn) error {
	if AllowPrivateProxy {
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return fmt.Errorf("endereço não reconhecido: %s", address)
	}
	if IsInternalIP(ip) {
		return fmt.Errorf("alvo interno/privado bloqueado: %s", host)
	}
	return nil
}

// IsBlockedTarget resolve hostname via DNS e reporta se QUALQUER endereço
// retornado cai numa faixa interna — mesma checagem de server.js:isBlockedTarget.
//
// Por que isso existe ALÉM de DialControl (que já valida o IP no momento da
// conexão real): quando HTTP_PROXY/HTTPS_PROXY está configurado, o
// http.Transport disca para o PROXY, não para o alvo final — DialControl
// nesse caso só vê o endereço do proxy, não o do host que estamos de fato
// tentando alcançar. Esta função checa o hostname do ALVO explicitamente,
// antes da requisição (e a cada redirect), fechando esse caso — igual ao
// server.js, que chama isBlockedTarget antes de doUpstreamRequest
// independente de haver proxy configurado ou não.
func IsBlockedTarget(ctx context.Context, hostname string) bool {
	if AllowPrivateProxy {
		return false
	}
	if IsBlockedHostname(hostname) {
		return true
	}
	if ip := net.ParseIP(strings.Trim(hostname, "[]")); ip != nil {
		return IsInternalIP(ip)
	}
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil || len(addrs) == 0 {
		return true // não resolveu: bloqueia (fail-closed, igual ao server.js)
	}
	for _, a := range addrs {
		if IsInternalIP(a.IP) {
			return true
		}
	}
	return false
}
