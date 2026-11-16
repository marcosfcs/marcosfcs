#!/bin/sh
# Instala o yt-dlp (binário standalone, sem Python) em ./bin/yt-dlp.
#
# Roda como build hook do Tsuru (ver tsuru.yaml) para o resolvedor de YouTube
# do server.js funcionar no app publicado. É "melhor esforço": qualquer falha
# (sem rede, checksum diferente, binário que não executa) vira um aviso e a
# saída é 0, para nunca derrubar o deploy — o app só fica sem o YouTube.
#
# O binário é verificado contra o SHA2-256SUMS publicado junto da release; sem
# o arquivo de checksums, não instala. Variáveis opcionais:
#   YTDLP_INSTALL_DIR  destino (padrão: bin)
#   YTDLP_BASE_URL     origem dos arquivos (padrão: última release do GitHub)

warn() { echo "[yt-dlp] AVISO: $*" >&2; exit 0; }

DEST_DIR="${YTDLP_INSTALL_DIR:-bin}"
BASE="${YTDLP_BASE_URL:-https://github.com/yt-dlp/yt-dlp/releases/latest/download}"

case "$(uname -m)" in
  x86_64|amd64)  ASSET=yt-dlp_linux ;;
  aarch64|arm64) ASSET=yt-dlp_linux_aarch64 ;;
  *) warn "arquitetura $(uname -m) sem binário standalone; pulando" ;;
esac

if [ -x "$DEST_DIR/yt-dlp" ]; then
  echo "[yt-dlp] já instalado em $DEST_DIR/yt-dlp; pulando"
  exit 0
fi

# curl e wget respeitam HTTPS_PROXY/HTTP_PROXY do ambiente de build
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 --connect-timeout 15 --max-time 240 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -T 30 -O "$2" "$1"; }
else
  warn "nem curl nem wget disponíveis; pulando"
fi
command -v sha256sum >/dev/null 2>&1 || warn "sha256sum indisponível; não instalo sem verificar o checksum"

TMP="$(mktemp -d 2>/dev/null)" || warn "não foi possível criar diretório temporário"
trap 'rm -rf "$TMP"' EXIT

echo "[yt-dlp] baixando $ASSET de $BASE"
fetch "$BASE/$ASSET" "$TMP/$ASSET" || warn "download do binário falhou"
fetch "$BASE/SHA2-256SUMS" "$TMP/SUMS" || warn "download do SHA2-256SUMS falhou"

EXPECTED="$(grep " $ASSET\$" "$TMP/SUMS" | head -n 1 | awk '{print $1}')"
ACTUAL="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
[ -n "$EXPECTED" ] || warn "checksum de $ASSET não encontrado no SHA2-256SUMS"
[ "$EXPECTED" = "$ACTUAL" ] || warn "checksum diferente (esperado $EXPECTED, obtido $ACTUAL); não instalo"

chmod +x "$TMP/$ASSET"
VERSION="$("$TMP/$ASSET" --version 2>&1)" || warn "o binário baixado não executa neste sistema: $VERSION"

mkdir -p "$DEST_DIR" || warn "não foi possível criar $DEST_DIR"
mv "$TMP/$ASSET" "$DEST_DIR/yt-dlp" || warn "não foi possível mover o binário para $DEST_DIR"
echo "[yt-dlp] instalado em $DEST_DIR/yt-dlp (versão $VERSION)"
