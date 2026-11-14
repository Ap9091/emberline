// ─────────────────────────────────────────────────────────────────────────────
// util.js - small helpers used everywhere (DOM building, number/time formatting).
// ─────────────────────────────────────────────────────────────────────────────

/** Build a DOM element: h('div', {class: 'card', onclick: fn}, 'text', childEl, ...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** SVG version of h() */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** Replace everything inside an element */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(Boolean));
  return el;
}

// ── numbers ──────────────────────────────────────────────────────────────────
export const fmtInt = n => (n === null || n === undefined) ? '-' : Math.round(n).toLocaleString('en-US');
export const fmt1 = n => (n === null || n === undefined) ? '-' : Number(n).toFixed(1);
export const fmtKm2 = n => (n === null || n === undefined) ? '-' : (n >= 100 ? fmtInt(n) : fmt1(n));
export const fmtPct = p => (p === null || p === undefined) ? '-' : (p > 0 && p < 0.01 ? '<1%' : Math.round(p * 100) + '%');
export const fmtSigned = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtKm2(Math.abs(n));

// ── times ────────────────────────────────────────────────────────────────────
/** "15:16" (UTC) from an ISO string */
export function utcHM(iso) {
  if (!iso) return '--:--';
  const d = new Date(String(iso).replace(' ', 'T'));
  return isNaN(d) ? '--:--' : d.toISOString().slice(11, 16);
}

/** "25 Jul 2024" (UTC date) from an ISO string */
export function utcDate(iso) {
  const d = new Date(String(iso).replace(' ', 'T'));
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Clock time of this computer, used for the event log: "14:03:22" */
export function nowHMS() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

/** "Wed 24 Jul 2024 19:00 PDT" → "19:00"   (also works for "24 Jul 19:00") */
export function localHM(timeLocal) {
  const m = /(\d{1,2}:\d{2})/.exec(timeLocal || '');
  return m ? m[1] : '';
}

/** "Wed 24 Jul 2024 19:00 PDT" → "19:00 PDT" */
export function localHMZone(timeLocal) {
  const m = /(\d{1,2}:\d{2})\s*([A-Z]{2,4})?/.exec(timeLocal || '');
  return m ? (m[1] + (m[2] ? ' ' + m[2] : '')) : '';
}

// ── wind ─────────────────────────────────────────────────────────────────────
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = deg => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

/** A small arrow pointing where the wind blows TO (from_deg + 180). size in px. */
export function windArrow(fromDeg, size = 16) {
  const to = ((fromDeg ?? 0) + 180) % 360;
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, class: 'wind-arrow', style: `transform: rotate(${to}deg)` },
    svg('path', { d: 'M12 2 L18.5 20 L12 15.5 L5.5 20 Z', fill: 'currentColor' }));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Copy text to the clipboard; returns true if it worked. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

// ── hover tooltip (one shared element, used by the timeline ticks) ───────────
export function showTooltip(text, x, y) {
  const tip = $('#tooltip');
  tip.textContent = text; tip.hidden = false;
  const w = tip.offsetWidth;
  tip.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, x - w / 2)) + 'px';
  tip.style.top = (y - tip.offsetHeight - 10) + 'px';
}
export function hideTooltip() { $('#tooltip').hidden = true; }

/** '2024-07-24T23:40:00Z' -> '24 Jul 16:40' in California time (PDT/PST). */
const PACIFIC = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Los_Angeles', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false });
export function pacific(iso) {
  if (!iso) return '-';
  const parts = Object.fromEntries(PACIFIC.formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
}

/** A signed number of hours: +2.5 h / −0.5 h */
export const fmtHours = x => (x === null || x === undefined) ? '-' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)} h`;
