/**
 * Motor de alertas de monitoração (estilo broadcast).
 *
 * Cada condição registrada é reavaliada a cada tick do loop de telemetria
 * e passa por uma máquina de estados com tempo de sustentação:
 *
 *   ocioso → (condição verdadeira) → pendente → (sustentada por N s) →
 *   ATIVO → (condição falsa) → resolvido → ocioso
 *
 * Transições para ATIVO e para resolvido geram entradas no log de eventos
 * e atualizam o painel #alert-list.
 */
'use strict';

class AlertEngine {
  /**
   * @param {object} opts { listEl, onLog(msg), thresholds: {…} }
   */
  constructor(opts) {
    this.listEl = opts.listEl;
    this.onLog = opts.onLog || (() => {});
    this.thresholds = opts.thresholds;
    this.conditions = new Map(); // key -> def
    this.history = [];           // {key,label,severity,startT,endT|null}
    this.render();
  }

  /**
   * @param {string} key
   * @param {object} def
   *   label: string                  nome exibido
   *   severity: 'critical'|'warning'
   *   sustainSec: number             tempo mínimo com a condição verdadeira
   *   test: (ctx) => boolean|null    null = "não avaliável agora" (não conta p/ nenhum lado)
   */
  register(key, def) {
    this.conditions.set(key, {
      ...def,
      state: 'idle',
      pendingSince: null,
      activeEntry: null,
    });
  }

  /** Avalia todas as condições. ctx é o snapshot do tick (buffer, dbfs, luma…). */
  evaluate(t, ctx) {
    let changed = false;
    for (const [key, c] of this.conditions) {
      const result = c.test(ctx);
      if (result === null) continue; // sem dados — mantém estado

      if (result) {
        if (c.state === 'idle') {
          c.state = 'pending';
          c.pendingSince = t;
        } else if (c.state === 'pending' && t - c.pendingSince >= c.sustainSec) {
          c.state = 'active';
          c.activeEntry = { key, label: c.label, severity: c.severity, startT: t, endT: null };
          this.history.unshift(c.activeEntry);
          if (this.history.length > 50) this.history.pop();
          this.onLog(`ALERTA${c.severity === 'critical' ? ' CRÍTICO' : ''}: ${c.label}`);
          changed = true;
        }
      } else {
        if (c.state === 'active') {
          c.activeEntry.endT = t;
          this.onLog(`Alerta resolvido: ${c.label} (durou ${Math.round(t - c.activeEntry.startT)}s)`);
          c.activeEntry = null;
          changed = true;
        }
        c.state = 'idle';
        c.pendingSince = null;
      }
    }
    if (changed) this.render();
    return changed;
  }

  activeCount() {
    let n = 0;
    for (const c of this.conditions.values()) if (c.state === 'active') n++;
    return n;
  }

  snapshot() {
    return this.history.map((h) => ({ ...h }));
  }

  render() {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    if (!this.history.length) {
      const p = document.createElement('p');
      p.className = 'empty-note';
      p.textContent = 'Nenhum alerta até o momento.';
      this.listEl.appendChild(p);
      return;
    }
    for (const h of this.history) {
      const li = document.createElement('div');
      li.className = 'alert-item' + (h.endT === null ? ' alert-active' : '');
      const chip = document.createElement('span');
      chip.className = 'alert-chip alert-' + h.severity;
      chip.textContent = h.severity === 'critical' ? 'CRÍTICO' : 'ATENÇÃO';
      const label = document.createElement('span');
      label.className = 'alert-label';
      label.textContent = h.label;
      const when = document.createElement('span');
      when.className = 'alert-when';
      when.textContent = h.endT === null
        ? `ativo (desde ${fmtT(h.startT)})`
        : `${fmtT(h.startT)} → ${fmtT(h.endT)} (${Math.round(h.endT - h.startT)}s)`;
      li.append(chip, label, when);
      this.listEl.appendChild(li);
    }
  }
}

function fmtT(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

window.AlertEngine = AlertEngine;
