/**
 * Stream Inspector — camada de navegação e apresentação.
 *
 * Só UI: troca de painel (com deep link por hash e atalhos de teclado),
 * abas do monitor, resumo da Visão geral, contadores no menu e avisos do
 * player. Não mede nem parseia nada — app.js chama os ganchos expostos em
 * window.UI quando o modelo, os alertas ou os eventos mudam.
 */
'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* modo privado */ } },
  };

  const links = $$('#side-nav a[data-nav]');
  const panels = $$('.panel[data-panel]');
  const names = links.map((a) => a.dataset.nav);
  let current = 'overview';

  /* ---------- painéis ---------- */

  function select(name, opts) {
    if (!names.includes(name)) name = 'overview';
    current = name;
    for (const a of links) {
      const on = a.dataset.nav === name;
      a.classList.toggle('active', on);
      if (on) { a.setAttribute('aria-current', 'page'); a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
      else a.removeAttribute('aria-current');
    }
    for (const p of panels) p.hidden = p.dataset.panel !== name;
    refreshBlockNav();
    if (!(opts && opts.fromHash) && location.hash !== '#/' + name) {
      history.replaceState(null, '', '#/' + name);
    }
    // o painel anterior pode ter deixado a página rolada além do topo do novo
    const main = $('#main');
    if (main && main.getBoundingClientRect().top < 0) main.scrollIntoView({ block: 'start' });
    // força o ResizeObserver dos gráficos recém-exibidos
    window.dispatchEvent(new Event('resize'));
  }

  function fromHash() {
    const m = /^#\/([\w-]+)/.exec(location.hash);
    return m && names.includes(m[1]) ? m[1] : null;
  }

  $('#side-nav').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a) return;
    e.preventDefault();
    history.pushState(null, '', '#/' + a.dataset.nav); // botão "voltar" percorre as seções
    select(a.dataset.nav, { fromHash: true });
  });
  window.addEventListener('popstate', () => select(fromHash() || 'overview', { fromHash: true }));

  /* ---------- "Nesta seção": atalhos para blocos de painéis longos ---------- */

  for (const p of panels) {
    const blocks = [...p.querySelectorAll(':scope > [data-block]')];
    if (blocks.length < 3) continue;
    const nav = document.createElement('div');
    nav.className = 'block-nav';
    nav.setAttribute('aria-label', 'Nesta seção');
    for (const b of blocks) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.dataset.block;
      btn.addEventListener('click', () => b.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      btn._block = b;
      nav.appendChild(btn);
    }
    p.querySelector('h2').after(nav);
  }
  function refreshBlockNav() {
    for (const nav of $$('.block-nav')) {
      let visible = 0;
      for (const btn of nav.children) { btn.hidden = btn._block.hidden; if (!btn.hidden) visible++; }
      nav.hidden = visible < 2; // um bloco só não precisa de índice
    }
  }
  // blocos aparecem/somem de forma assíncrona (container, anúncios)
  if (window.MutationObserver) {
    const mo = new MutationObserver(refreshBlockNav);
    for (const b of $$('.panel > [data-block]')) mo.observe(b, { attributes: true, attributeFilter: ['hidden'] });
  }

  /* ---------- abas do monitor ---------- */

  const dockTabs = $$('.dock-tabs [data-dock]');
  function selectDock(name) {
    for (const t of dockTabs) t.setAttribute('aria-selected', String(t.dataset.dock === name));
    for (const pane of $$('[data-dock-pane]')) pane.hidden = pane.dataset.dockPane !== name;
    store.set('si.dockTab', name);
    window.dispatchEvent(new Event('resize'));
  }
  for (const t of dockTabs) t.addEventListener('click', () => selectDock(t.dataset.dock));

  const shell = $('#results');
  const dockBtn = $('#btn-dock-toggle');
  function setDockCollapsed(on) {
    shell.classList.toggle('dock-collapsed', on);
    dockBtn.setAttribute('aria-pressed', String(on));
    dockBtn.textContent = on ? 'Expandir monitor' : 'Recolher monitor';
    store.set('si.dockCollapsed', on ? '1' : '0');
    window.dispatchEvent(new Event('resize'));
  }
  dockBtn.addEventListener('click', () => setDockCollapsed(!shell.classList.contains('dock-collapsed')));

  $('#btn-copy-url').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText($('#session-url').title);
      btn.textContent = 'Copiado';
    } catch { btn.textContent = 'Não foi possível copiar'; }
    setTimeout(() => { btn.textContent = 'Copiar URL'; }, 1600);
  });

  /* ---------- popover de exemplos ---------- */

  const pop = $('.examples-pop');
  document.addEventListener('click', (e) => {
    if (!pop.open) return;
    if (!pop.contains(e.target) || e.target.closest('[data-example]')) pop.open = false;
  });

  /* ---------- atalhos de teclado ---------- */

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { pop.open = false; if (document.activeElement === $('#url')) $('#url').blur(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if (e.key === '/') { e.preventDefault(); $('#url').focus(); $('#url').select(); return; }
    if (shell.hidden) return;
    const k = e.key.toLowerCase();
    let target = null;
    if (/^[0-9]$/.test(k)) target = names[k === '0' ? 9 : Number(k) - 1];
    else if (k === 'h') target = 'historico';
    else if (k === '[' || k === ']') {
      const i = names.indexOf(current) + (k === ']' ? 1 : -1);
      target = names[(i + names.length) % names.length];
    } else if (k === 'm' && !document.body.hasAttribute('data-readonly')) {
      setDockCollapsed(!shell.classList.contains('dock-collapsed'));
      return;
    }
    if (target) { e.preventDefault(); select(target); }
  });

  /* ---------- altura real da barra superior (inclui a linha de status) ---------- */

  const topbar = $('.app-topbar');
  const syncTopbar = () => document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  if (window.ResizeObserver) new ResizeObserver(syncTopbar).observe(topbar);
  syncTopbar();

  /* ---------- ganchos chamados por app.js ---------- */

  function setCount(key, value, flag) {
    const b = $(`.nav-count[data-count="${key}"]`);
    if (!b) return;
    b.textContent = value == null || value === 0 ? '' : String(value);
    b.classList.toggle('flag', !!flag);
  }

  /** Entra na visão de sessão. readonly = sessão do histórico (sem player). */
  function showSession(info) {
    document.body.dataset.view = 'session';
    if (info.readonly) document.body.setAttribute('data-readonly', '');
    else document.body.removeAttribute('data-readonly');
    shell.hidden = false;
    const u = $('#session-url');
    u.textContent = info.url || '';
    u.title = info.url || '';
    playerNotice(null);
    setAlerts(0);
    if (info.readonly || !info.keepPanel) select(info.readonly ? 'overview' : (fromHash() || current));
  }

  function card(label, value, detail, nav, cls) {
    const c = document.createElement(nav ? 'button' : 'div');
    if (nav) { c.type = 'button'; c.addEventListener('click', () => select(nav)); c.title = 'Abrir a seção'; }
    c.className = 'summary-card' + (cls ? ' ' + cls : '');
    for (const [k, v] of [['sc-label', label], ['sc-value', value], ['sc-detail', detail]]) {
      const s = document.createElement('span');
      s.className = k;
      s.textContent = v || '';
      c.appendChild(s);
    }
    return c;
  }

  /** Atualiza resumo da Visão geral e contadores do menu a partir do modelo. */
  function onModel(model) {
    const P = window.StreamParsers;
    const ov = model.overview || {};
    const video = model.video || [];
    const audio = model.audio || [];
    const subs = [...(model.subtitles || []), ...(model.closedCaptions || [])];
    const drm = (model.drm || []).filter((d) => d.system && d.system !== 'Sem criptografia');
    const box = $('#overview-summary');
    box.innerHTML = '';

    const tx = ov['Transmissão'] || '';
    const live = /AO VIVO/.test(tx);
    const dur = ov['Duração total'] || ov['Duração da apresentação'] || ov['Duração'];
    box.appendChild(card('Protocolo', model.protocol || '—', ov['Tipo de manifest'] || ''));
    if (tx) box.appendChild(card('Transmissão', live ? 'Ao vivo' : 'VOD', dur && dur !== '—' ? 'Duração ' + dur : '', 'segmentacao', live ? 'is-live' : ''));

    if (video.length) {
      const px = (v) => { const m = /^(\d+)x(\d+)$/.exec(v.resolution || ''); return m ? m[1] * m[2] : 0; };
      const top = video.reduce((a, b) => (px(b) > px(a) ? b : a));
      const rates = video.map((v) => v.bandwidth).filter(Boolean);
      const range = rates.length ? `${P.fmtBits(Math.min(...rates))} – ${P.fmtBits(Math.max(...rates))}` : '';
      box.appendChild(card('Vídeo', `${video.length} variante${video.length > 1 ? 's' : ''}`,
        [px(top) ? 'até ' + top.resolution.replace('x', '×') : '', range].filter(Boolean).join(' · '), 'video'));
      const hdr = [...new Set(video.filter((v) => v.hdr).map((v) => v.videoRange))];
      box.appendChild(card('Faixa dinâmica', hdr.length ? 'HDR' : 'SDR', hdr.join(' · ') || 'nenhuma variante HDR', 'cor', hdr.length ? 'is-accent' : ''));
    }
    const langs = [...new Set(audio.map((a) => a.lang).filter((l) => l && l !== '—'))];
    box.appendChild(card('Áudio', audio.length ? `${audio.length} faixa${audio.length > 1 ? 's' : ''}` : 'Nenhuma faixa',
      langs.slice(0, 4).join(', ') + (langs.length > 4 ? '…' : ''), 'audio'));
    box.appendChild(card('Legendas / CC', subs.length ? `${subs.length} faixa${subs.length > 1 ? 's' : ''}` : 'Nenhuma',
      [...new Set(subs.map((s) => s.lang).filter((l) => l && l !== '—'))].slice(0, 4).join(', '), 'legendas'));
    box.appendChild(card('Proteção', drm.length ? 'Protegido' : 'Sem DRM',
      drm.length ? [...new Set(drm.map((d) => d.system))].join(', ') : 'nenhuma criptografia declarada', 'legendas', drm.length ? 'is-warn' : ''));

    setCount('video', video.length);
    setCount('audio', audio.length);
    setCount('legendas', drm.length ? 'DRM' : subs.length, drm.length > 0);
  }

  /** Classifica uma linha do log de eventos para dar peso visual a erros/alertas. */
  function onEvent(li, msg) {
    if (/FATAL|^Erro|^Falha|ALERTA CRÍTICO|Não foi possível/i.test(msg)) li.classList.add('ev-error');
    else if (/^ALERTA|Rebuffering|bloqueado|TESTE DE REDE/i.test(msg)) li.classList.add('ev-warn');
    else if (/resolvido/i.test(msg)) li.classList.add('ev-good');
  }

  function setAlerts(active, severity) {
    const b = $('#alert-count');
    b.hidden = !active;
    b.textContent = active ? String(active) : '';
    b.dataset.severity = severity || 'critical';
  }
  /** Chamado a cada render do AlertEngine. */
  function onAlerts(engine) {
    const active = engine.history.filter((h) => h.endT === null);
    setAlerts(active.length, active.some((h) => h.severity === 'critical') ? 'critical' : 'warning');
  }

  /** Aviso persistente sob o player (erro fatal, autoplay bloqueado). null limpa. */
  function playerNotice(msg, kind) {
    const n = $('#player-notice');
    n.hidden = !msg;
    n.textContent = msg || '';
    n.dataset.kind = kind || 'error';
    const st = $('#tile-state');
    if (msg && kind !== 'info') { st.textContent = 'erro'; st.dataset.state = 'erro'; }
  }

  function setHistoryCount(n) { setCount('historico', n); }

  /* ---------- estado inicial ---------- */

  selectDock(store.get('si.dockTab') || 'events');
  if (store.get('si.dockCollapsed') === '1') setDockCollapsed(true);
  const initial = fromHash();
  if (initial) select(initial, { fromHash: true });

  window.UI = { select, showSession, onModel, onEvent, onAlerts, playerNotice, setHistoryCount };
  window.selectCockpitPanel = select; // compat: nome usado antes do redesenho
})();
