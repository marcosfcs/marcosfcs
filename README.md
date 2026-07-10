# 📡 Stream Inspector — HLS / MPEG-DASH

Sistema web para inspeção completa de transmissões de streaming a partir da URL do
manifest (`.m3u8` ou `.mpd`). Cole a URL, clique em **Inspecionar** e o sistema
apresenta tudo o que a transmissão contém:

| Camada | O que é apresentado | Formato |
|---|---|---|
| Metadados | protocolo, tipo (VOD/ao vivo), versão, perfis, duração, períodos, buffer mínimo | tabela estática |
| Vídeo | variantes/representações: resolução, bitrate pico/médio, FPS, codec (nome amigável + string), faixa de vídeo (SDR/PQ/HLG/Dolby Vision), HDCP | tabela estática |
| Áudio | faixas: idioma, canais (estéreo/5.1/Atmos), codec, amostragem, bitrate, papéis | tabela estática |
| Legendas | legendas e closed captions: idioma, formato (WebVTT/TTML/CEA-608), forçada/padrão | tabela estática |
| DRM | Widevine, PlayReady, FairPlay, ClearKey, AES (via `EXT-X-KEY`/`ContentProtection`), default_KID | tabela estática |
| Segmentação | modo (SegmentTemplate/Timeline/playlist), contagem, durações, descontinuidades | tabela + **gráfico temporal estático** |
| Telemetria | buffer de reprodução, bitrate do nível ativo, banda estimada, frames perdidos, latência live, trocas de ABR | **gráficos temporais dinâmicos** + tiles |
| Análise de cor | **curvas de cor por canal RGB**, distribuição de luminância, luminância média (APL) e clipping de sombras/realces ao longo do tempo, sinalização SDR/HDR do manifest × capacidade do display | **gráficos de curva** + tabela |

## Como rodar

Requer apenas Node.js (≥16, sem dependências externas):

```bash
node server.js
# → http://localhost:8787
```

Também funciona hospedado como página estática (`public/`), porém **sem o proxy
de CORS** — nesse modo só é possível inspecionar streams cuja origem envie
cabeçalhos CORS (`Access-Control-Allow-Origin`).

## Arquitetura

```
server.js                 servidor estático + proxy de CORS (Node puro, zero deps)
public/
  index.html              UI (campo de URL + botão + seções de resultado)
  css/style.css           tokens de design (light/dark automático)
  js/parsers.js           parsers próprios de M3U8 e MPD → modelo normalizado
  js/charts.js            gráficos em canvas (séries temporais, curvas, degraus)
  js/analyzer.js          análise de cor por frame (histogramas RGB/luma, clipping)
  js/app.js               orquestração: fetch → parse → tabelas → playback → telemetria
  vendor/hls.min.js       playback HLS (hls.js)
  vendor/dash.all.min.js  playback DASH (dash.js)
  samples/                manifests de exemplo (HLS com HDR/legendas/Atmos; MPD com DRM)
```

### Proxy de CORS (`/p/…`)

Manifests de origens sem CORS são buscados automaticamente via
`/p/<scheme>/<host>/<caminho>`. O formato por caminho (em vez de `?url=`) faz as
URLs **relativas** dos manifests resolverem naturalmente através do proxy;
URLs **absolutas** internas (variantes, chaves, `BaseURL`, `media=`) são
reescritas pelo servidor. `HTTP(S)_PROXY` do ambiente é respeitado (túnel CONNECT).

### Análise SDR/HDR

- **Sinalização**: `VIDEO-RANGE` (HLS), CICP `TransferCharacteristics`/`ColourPrimaries`
  (DASH) e codecs (Dolby Vision, HEVC Main 10) → exibida por variante e em badge.
- **Capacidade do display**: `dynamic-range`, `color-gamut` e profundidade de cor.
- **Curvas**: frames são amostrados em canvas e geram histogramas por canal R/G/B e
  de luminância (Rec.709), além da evolução temporal de APL e clipping.
  *Limitação documentada na UI*: o canvas entrega pixels 8-bit já tone-mapped pelo
  navegador — para conteúdo PQ/HLG as curvas refletem o resultado renderizado.

### Observações

- Streams com DRM: os metadados e a telemetria de manifest funcionam; a leitura de
  pixels (curvas de cor) é bloqueada pelo navegador e a UI informa isso.
- Playlists de mídia (variante única) também são aceitas diretamente.
- Para live, os gráficos usam janela deslizante de 120 s e o tile de latência é exibido.
