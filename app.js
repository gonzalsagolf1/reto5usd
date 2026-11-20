// Reto 5 USD en el teléfono. Lee el último resumen cifrado que publicó la app de la PC
// y le manda pedidos cifrados (confirmar, descartar o cargar compras). Sin servidor propio:
// los mensajes pasan por ntfy.sh, que solo ve texto ilegible.
import { decrypt, encrypt } from './crypto.js';

const NTFY = 'https://ntfy.sh';
const POLL_MS = 30000;
const LS = { link: 'reto5-link', snap: 'reto5-snap', sent: 'reto5-sent' };
const NAMES = { SPY: 'S&P 500', QQQ: 'Nasdaq 100', IVV: 'iShares S&P 500', BTC: 'Bitcoin', ETH: 'Ethereum', IBIT: 'Bitcoin (CEDEAR)' };
const LOGOS = { BTC: 'btc.svg', ETH: 'eth.svg', QQQ: 'qqq-mark.svg', SPY: 'spy.jpg', IVV: 'ivv.svg', IBIT: 'ibit.svg' };
const LOCAL = new Set(['IVV', 'IBIT']); // CEDEARs con precio en pesos por unidad
const ASSETS = Object.keys(NAMES);

// ---------- Utilidades ----------
const store = {
  get(k, def = null) {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : def;
    } catch {
      return def;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* sin almacenamiento: la página sigue andando en memoria */
    }
  },
};

const nf = (d) => new Intl.NumberFormat('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : nf(d).format(n));
const fmtSigned = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d));
const fmtQty = (n) =>
  n == null ? '—' : new Intl.NumberFormat('es-AR', { maximumFractionDigits: n >= 100 ? 2 : n >= 1 ? 4 : 6 }).format(n);
const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
};
const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'recién';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const parseNum = (v) => {
  let s = String(v ?? '')
    .trim()
    .replace(/\s/g, '');
  if (!s) return NaN;
  // Formato argentino: coma decimal y punto de miles («5.980» son cinco mil novecientos ochenta).
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return /^\d*\.?\d+$/.test(s) ? Number(s) : NaN;
};
const uid = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    // La CSP no permite style en el HTML: se aplica por CSSOM.
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
function icon(paths) {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}
const ICON = {
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4h-4'],
  plus: ['M12 5v14M5 12h14'],
};

const logo = (a) => h('span', { class: `logo ${a.toLowerCase()}` }, h('img', { src: `logos/${LOGOS[a]}`, alt: '' }));

let toastTimer;
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

// ---------- Estado ----------
let link = store.get(LS.link);
let snap = store.get(LS.snap);
let sent = store.get(LS.sent, []);
let loading = false;
let lastError = null;

/** El QR trae canales y clave en el # (nunca llega al servidor de la página). */
function readHash() {
  if (!location.hash.includes('k=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const next = { o: p.get('o'), i: p.get('i'), k: p.get('k') };
  history.replaceState(null, '', location.pathname + location.search);
  const ok = /^[\w-]{12,64}$/.test(next.o || '') && /^[\w-]{12,64}$/.test(next.i || '') && /^[\w-]{40,48}$/.test(next.k || '');
  if (!ok) return toast('El link no es válido. Escaneá el código de nuevo.');
  const changed = link?.k !== next.k;
  if (changed) {
    snap = null;
    sent = [];
    store.set(LS.snap, null);
    store.set(LS.sent, []);
  }
  link = next;
  store.set(LS.link, link);
  // El ícono de inicio abre siempre con el link: solo se avisa la primera vez.
  if (changed) toast('¡Listo! Teléfono vinculado.');
}

async function fetchSnap() {
  if (!link || loading) return;
  loading = true;
  render();
  try {
    const res = await fetch(`${NTFY}/${link.o}/json?poll=1&since=12h`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lines = (await res.text()).split('\n').filter(Boolean).reverse();
    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.event !== 'message') continue;
      const raw = await decrypt(ev.message, link.k);
      if (!raw) continue;
      const data = JSON.parse(raw);
      if (data?.v !== 1 || data.kind !== 'snap') continue;
      if (!snap || data.at >= snap.at) {
        snap = data;
        store.set(LS.snap, snap);
      }
      break;
    }
    lastError = null;
    // Lo enviado que la PC ya resolvió hace más de un día se olvida.
    const done = new Set((snap?.results || []).map((r) => r.id));
    sent = sent.filter((s) => !done.has(s.id) || Date.now() - s.at < 86400000);
    store.set(LS.sent, sent);
  } catch {
    lastError = 'Sin conexión: muestro lo último que tengo.';
  }
  loading = false;
  render();
}

async function sendCommand(op, payload, label) {
  const cmd = { v: 1, kind: 'cmd', id: uid(), ts: Date.now(), op, ...payload };
  const body = await encrypt(JSON.stringify(cmd), link.k);
  const res = await fetch(`${NTFY}/${link.i}`, { method: 'POST', body });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  sent.push({ id: cmd.id, op, target: payload.target || null, label, at: Date.now() });
  store.set(LS.sent, sent);
  render();
  return cmd.id;
}

const resultOf = (id) => (snap?.results || []).find((r) => r.id === id);

// ---------- Pantallas ----------
function unlinked() {
  return h(
    'section',
    { class: 'empty' },
    h('img', { src: 'icon.svg', alt: '' }),
    h('h1', null, 'Reto 5 USD'),
    h('p', { class: 'faint' }, 'Para ver tu cartera acá, vinculá este teléfono con la app de tu PC.'),
    h(
      'ol',
      null,
      h('li', null, 'En la PC, abrí Reto 5 USD → Ajustes → Web del teléfono.'),
      h('li', null, 'Tocá «Vincular teléfono».'),
      h('li', null, 'Escaneá el código con la cámara del iPhone y abrí el link.'),
    ),
    h('p', { class: 'faint' }, 'Tus datos viajan cifrados: esta página no guarda nada en ningún servidor.'),
  );
}

function header() {
  const status = loading ? 'Actualizando…' : lastError || (snap ? `Actualizado ${ago(snap.at)}` : 'Esperando datos de tu PC…');
  return h(
    'header',
    { class: 'top' },
    h('img', { src: 'icon.svg', alt: '' }),
    h('div', null, h('h1', null, 'Reto 5 USD'), h('div', { class: 'faint' }, status)),
    h('button', { class: `icon-btn ${loading ? 'spin' : ''}`, 'aria-label': 'Actualizar', onclick: fetchSnap }, icon(ICON.refresh)),
  );
}

function heroCard(s) {
  const pnlCls = s.sum.pnl > 0 ? 'pos' : s.sum.pnl < 0 ? 'neg' : '';
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'eyebrow' }, `Día ${s.sum.dayNumber} de ${s.plan.days}`),
    h('div', { class: 'hero-value num' }, h('b', null, fmt(s.sum.invested)), h('span', null, `USD de ${fmt(s.plan.target, 0)}`)),
    h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(1, Math.min(100, s.sum.pct))}%` })),
    h('div', { class: 'faint num' }, `${fmt(s.sum.pct, 1)} % del reto`),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'eyebrow' }, 'Vale hoy'), h('b', { class: 'num' }, fmt(s.sum.value))),
      h(
        'div',
        { class: 'stat' },
        h('div', { class: 'eyebrow' }, 'Resultado'),
        h('b', { class: `num ${pnlCls}` }, `${fmtSigned(s.sum.pnlPct, 1)} %`),
      ),
      h('div', { class: 'stat' }, h('div', { class: 'eyebrow' }, 'Compras'), h('b', { class: 'num' }, String(s.sum.count))),
    ),
  );
}

function pendingCard(s) {
  const list = (s.pending || []).filter((p) => !sent.some((x) => x.target === p.id && resultOf(x.id)?.ok));
  if (!list.length) return null;
  return h(
    'section',
    { class: 'card pending' },
    h(
      'div',
      { class: 'card-head' },
      h('div', null, h('div', { class: 'eyebrow' }, 'Para confirmar'), h('h2', null, 'Compras detectadas')),
      h('span', { class: 'chip accent' }, `${list.length}`),
    ),
    list.map((p) => {
      const mine = sent.filter((x) => x.target === p.id).pop();
      const r = mine && resultOf(mine.id);
      const money = p.total != null ? `${p.currency === 'USD' ? 'US$' : '$'} ${fmt(p.total, p.currency === 'USD' ? 2 : 0)}` : '';
      return h(
        'div',
        { class: 'p-item' },
        h(
          'div',
          { class: 'row', style: 'padding:0;background:none' },
          p.asset ? logo(p.asset) : null,
          h(
            'div',
            { class: 'grow' },
            h('b', null, `${p.qty != null ? fmtQty(p.qty) + ' ' : ''}${p.asset || 'Compra'}`),
            h('small', null, [fmtDate(p.date), money, p.source === 'phone' ? 'desde el teléfono' : 'Balanz'].filter(Boolean).join(' · ')),
          ),
        ),
        mine
          ? h(
              'div',
              { class: `p-state ${r ? (r.ok ? 'ok' : 'err') : ''}` },
              r ? r.text : `${mine.op === 'confirm' ? 'Agregar' : 'Descartar'}: enviado. Se aplica cuando la app de la PC esté abierta.`,
            )
          : h(
              'div',
              { class: 'actions' },
              h('button', { class: 'btn', onclick: (e) => act(e, 'dismiss', p, 'Descartar') }, 'Descartar'),
              h('button', { class: 'btn primary', onclick: (e) => act(e, 'confirm', p, 'Agregar') }, 'Agregar al reto'),
            ),
      );
    }),
  );
}

async function act(e, op, p, label) {
  e.currentTarget.disabled = true;
  try {
    await sendCommand(op, { target: p.id }, `${label} ${p.asset || ''}`);
    toast(op === 'confirm' ? 'Enviado: se agrega en tu PC' : 'Descartada');
    setTimeout(fetchSnap, 8000);
  } catch {
    e.currentTarget.disabled = false;
    toast('No se pudo enviar. Revisá la conexión.');
  }
}

function sentCard() {
  const adds = sent
    .filter((x) => x.op === 'add')
    .slice(-4)
    .reverse();
  if (!adds.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'eyebrow' }, 'Enviadas desde acá'),
    h('h2', null, 'Compras que cargaste'),
    h(
      'div',
      { class: 'list' },
      adds.map((x) => {
        const r = resultOf(x.id);
        return h(
          'div',
          { class: 'row' },
          h(
            'div',
            { class: 'grow' },
            h('b', null, x.label),
            h(
              'small',
              { class: r ? (r.ok ? 'pos' : 'neg') : '' },
              r ? r.text : `Enviada ${ago(x.at)} · se suma cuando la app de la PC esté abierta`,
            ),
          ),
        );
      }),
    ),
  );
}

function alertsCard(s) {
  if (!s.alerts?.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'eyebrow' }, 'Alertas'),
    h('h2', null, 'Para tener en cuenta'),
    h(
      'div',
      { class: 'list' },
      s.alerts.map((a) => h('div', { class: `row alert ${a.kind}` }, logo(a.asset), h('div', { class: 'grow' }, h('b', null, a.title)))),
    ),
  );
}

function buyCard(s) {
  if (!s.buy?.items?.length) return null;
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('div', null, h('div', { class: 'eyebrow' }, 'Según tu distribución'), h('h2', null, 'Qué comprar hoy')),
      h('span', { class: 'chip' }, `${fmt(s.buy.amountUsd)} USD`),
    ),
    h(
      'div',
      { class: 'list' },
      s.buy.items.map((i) =>
        h(
          'div',
          { class: 'row' },
          logo(i.asset),
          h(
            'div',
            { class: 'grow' },
            h('b', null, i.units ? `${i.units} ${i.units === 1 ? 'CEDEAR' : 'CEDEARs'} de ${i.asset}` : `${fmt(i.usd)} USD de ${i.asset}`),
            h('small', null, i.currency === 'ARS' && i.ars ? `≈ $ ${fmt(i.ars, 0)}` : `≈ ${fmt(i.usd)} USD`),
          ),
          i.currency ? h('span', { class: 'cur' }, i.currency === 'ARS' ? 'en pesos' : 'en dólares') : null,
        ),
      ),
    ),
  );
}

function holdingsCard(s) {
  if (!s.holdings?.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'eyebrow' }, 'Tu cartera'),
    h('h2', null, 'En qué invertiste'),
    h(
      'div',
      { class: 'list' },
      s.holdings.map((x) =>
        h(
          'div',
          { class: 'row' },
          logo(x.asset),
          h(
            'div',
            { class: 'grow' },
            h('b', null, x.asset),
            h('small', null, `${fmtQty(x.qty)} · ${fmt(x.weight, 0)} % de tu cartera${x.target ? ` (ideal ${fmt(x.target, 0)} %)` : ''}`),
            h(
              'div',
              { class: 'weight' },
              h('i', { style: `width:${Math.min(100, x.weight)}%` }),
              x.target ? h('em', { style: `left:${Math.min(100, x.target)}%` }) : null,
            ),
          ),
          h(
            'div',
            { class: 'right num' },
            h('b', null, fmt(x.value)),
            h('small', { class: x.pnlPct > 0 ? 'pos' : x.pnlPct < 0 ? 'neg' : '' }, `${fmtSigned(x.pnlPct, 1)} %`),
          ),
        ),
      ),
    ),
  );
}

function recentCard(s) {
  if (!s.recent?.length) return null;
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'eyebrow' }, 'Historial'),
    h('h2', null, 'Últimas compras'),
    h(
      'div',
      { class: 'list' },
      s.recent.map((c) =>
        h(
          'div',
          { class: 'row' },
          logo(c.asset),
          h('div', { class: 'grow' }, h('b', null, `${fmtQty(c.qty)} ${c.asset}`), h('small', null, fmtDate(c.date))),
          h(
            'div',
            { class: 'right num' },
            h('b', null, c.amountArs ? `$ ${fmt(c.amountArs, 0)}` : `${fmt(c.amountUsd)} USD`),
            c.amountArs ? h('small', null, `${fmt(c.amountUsd)} USD`) : null,
          ),
        ),
      ),
    ),
  );
}

/** El ícono de inicio guarda sus datos aparte de Safari: se crea con el link incluido. */
function openHomeSheet() {
  const root = document.getElementById('sheet-root');
  const frag = new URLSearchParams({ v: '1', o: link.o, i: link.i, k: link.k });
  history.replaceState(null, '', `${location.pathname}${location.search}#${frag}`);
  const close = () => {
    history.replaceState(null, '', location.pathname + location.search);
    root.replaceChildren();
  };
  root.replaceChildren(
    h('div', { class: 'scrim', onclick: close }),
    h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Agregar a la pantalla de inicio' },
      h('div', { class: 'grab' }),
      h('h2', null, 'Agregar a la pantalla de inicio'),
      h(
        'ol',
        { class: 'steps' },
        h('li', null, 'Tocá el botón ', h('b', null, 'Compartir'), ' de Safari (el cuadrado con la flecha hacia arriba).'),
        h('li', null, 'Bajá y elegí ', h('b', null, '«Agregar a inicio»'), '.'),
        h('li', null, 'Tocá ', h('b', null, '«Agregar»'), '. El ícono ya queda vinculado.'),
      ),
      h('p', { class: 'hint' }, 'Mientras esta ventana está abierta, la dirección tiene tu clave: no la copies ni la compartas.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: close }, 'Listo')),
    ),
  );
}

function footer() {
  const url = location.origin + location.pathname;
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  return h(
    'div',
    { class: 'foot' },
    standalone ? null : h('button', { class: 'btn home-btn', type: 'button', onclick: openHomeSheet }, 'Agregar a la pantalla de inicio'),
    h(
      'details',
      { class: 'help' },
      h('summary', null, 'Abrir con Siri'),
      h(
        'ol',
        null,
        h('li', null, 'Abrí la app Atajos y tocá «+».'),
        h('li', null, 'Agregá la acción «Abrir URL» y pegá esta dirección.'),
        h('li', null, 'Ponele de nombre «Reto». Después: «Oye Siri, Reto».'),
      ),
      h(
        'button',
        {
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast('Dirección copiada');
            } catch {
              toast(url);
            }
          },
        },
        'Copiar dirección',
      ),
    ),
    h('p', null, 'Información de tu plan, no es asesoramiento financiero.'),
    h(
      'button',
      {
        onclick: () => {
          if (!confirm('¿Desvincular este teléfono? Para volver a usarlo vas a tener que escanear el código otra vez.')) return;
          store.set(LS.link, null);
          store.set(LS.snap, null);
          store.set(LS.sent, null);
          link = null;
          snap = null;
          sent = [];
          render();
        },
      },
      'Desvincular este teléfono',
    ),
  );
}

// ---------- Cargar una compra ----------
function openAddSheet() {
  if (!snap) return toast('Primero tienen que llegar los datos de tu PC.');
  const root = document.getElementById('sheet-root');
  // Primero lo que ya tenés, después tu distribución ideal y al final el resto.
  const order = [...new Set([...(snap.holdings || []).map((x) => x.asset), ...Object.keys(snap.weights || {}), ...ASSETS])];
  let asset = order[0];
  let currency = 'ARS';
  const amount = h('input', { inputmode: 'decimal', placeholder: '0', autocomplete: 'off', id: 'f-amount' });
  const fee = h('input', { inputmode: 'decimal', placeholder: '0', autocomplete: 'off', id: 'f-fee' });
  const price = h('input', { inputmode: 'decimal', placeholder: '0', autocomplete: 'off', id: 'f-price' });
  const date = h('input', { type: 'date', value: todayISO(), max: todayISO(), id: 'f-date' });
  const amountUnit = h('span', null, 'ARS');
  const feeUnit = h('span', null, 'ARS');
  const priceUnit = h('span', null, 'ARS');
  const priceLabel = h('label', { for: 'f-price' }, 'Precio por unidad');
  const estimate = h('div', { class: 'hint' });
  const err = h('div', { class: 'err-msg' });

  const picks = order.map((a) =>
    h(
      'button',
      {
        class: 'pick',
        type: 'button',
        'aria-pressed': String(a === asset),
        onclick: () => {
          asset = a;
          picks.forEach((b, i) => b.setAttribute('aria-pressed', String(order[i] === asset)));
          fillPrice();
        },
      },
      logo(a),
      a,
    ),
  );
  const segBtns = ['ARS', 'USD'].map((c) =>
    h(
      'button',
      {
        type: 'button',
        'aria-pressed': String(c === currency),
        onclick: () => {
          currency = c;
          segBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['ARS', 'USD'][i] === currency)));
          amountUnit.textContent = feeUnit.textContent = c;
          fillPrice();
        },
      },
      c === 'ARS' ? 'Pesos' : 'Dólares',
    ),
  );

  function fillPrice() {
    const p = snap.prices?.[asset] || {};
    const inArs = currency === 'ARS' && LOCAL.has(asset);
    priceUnit.textContent = inArs ? 'ARS' : 'USD';
    priceLabel.textContent = inArs ? 'Precio por CEDEAR' : 'Precio por unidad';
    const v = inArs ? p.ars : p.usd;
    price.value = v ? String(Math.round(v * 100) / 100).replace('.', ',') : '';
    update();
  }

  function update() {
    const a = parseNum(amount.value);
    const f = parseNum(fee.value) || 0;
    const p = parseNum(price.value);
    const inArs = currency === 'ARS' && LOCAL.has(asset);
    if (!(a > 0) || !(p > 0)) return (estimate.textContent = '');
    const mep = snap.fx?.mep;
    let net = a - f;
    if (currency === 'ARS' && !inArs) net = mep ? net / mep : NaN;
    const qty = net / p;
    estimate.textContent = Number.isFinite(qty) && qty > 0 ? `Son unos ${fmtQty(qty)} ${asset}.` : '';
  }
  for (const el of [amount, fee, price]) el.addEventListener('input', update);

  const close = () => root.replaceChildren();
  const submit = h(
    'button',
    {
      class: 'btn primary',
      type: 'button',
      onclick: async () => {
        const a = parseNum(amount.value);
        const f = fee.value.trim() ? parseNum(fee.value) : 0;
        const p = price.value.trim() ? parseNum(price.value) : null;
        if (!(a > 0)) return (err.textContent = 'Poné el monto que pagaste.');
        if (!(f >= 0) || f >= a) return (err.textContent = 'La comisión tiene que ser menor al monto.');
        if (p != null && !(p > 0)) return (err.textContent = 'El precio no es válido.');
        if (!date.value || date.value > todayISO()) return (err.textContent = 'Elegí una fecha de hoy o anterior.');
        submit.disabled = true;
        err.textContent = '';
        try {
          const unit = currency === 'USD' ? 'US$' : '$';
          await sendCommand(
            'add',
            { data: { asset, currency, amount: a, fee: f, price: p, date: date.value } },
            `${asset} · ${unit} ${fmt(a, currency === 'USD' ? 2 : 0)} · ${fmtDate(date.value)}`,
          );
          close();
          toast('Enviada: se suma en tu PC');
          setTimeout(fetchSnap, 8000);
        } catch {
          submit.disabled = false;
          err.textContent = 'No se pudo enviar. Revisá la conexión.';
        }
      },
    },
    'Enviar a la PC',
  );

  root.replaceChildren(
    h('div', { class: 'scrim', onclick: close }),
    h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Cargar una compra' },
      h('div', { class: 'grab' }),
      h('h2', null, 'Cargar una compra'),
      h('div', { class: 'field' }, h('label', null, 'Activo'), h('div', { class: 'picker' }, picks)),
      h('div', { class: 'field' }, h('label', null, 'Moneda'), h('div', { class: 'seg' }, segBtns)),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'f-amount' }, 'Monto total, con comisión'),
        h('div', { class: 'input' }, amount, amountUnit),
        estimate,
      ),
      h(
        'div',
        { class: 'two' },
        h('div', { class: 'field' }, h('label', { for: 'f-fee' }, 'Comisión'), h('div', { class: 'input' }, fee, feeUnit)),
        h('div', { class: 'field' }, h('label', { for: 'f-date' }, 'Fecha'), h('div', { class: 'input' }, date)),
      ),
      h(
        'div',
        { class: 'field' },
        priceLabel,
        h('div', { class: 'input' }, price, priceUnit),
        h('div', { class: 'hint' }, 'Viene con el precio actual. Cambialo si pagaste otro.'),
      ),
      err,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancelar'), submit),
    ),
  );
  fillPrice();
  setTimeout(() => amount.focus(), 350);
}

// ---------- Render ----------
function render() {
  const app = document.getElementById('app');
  if (!link) {
    document.querySelector('.fab')?.remove();
    app.replaceChildren(unlinked());
    return;
  }
  const blocks = [header()];
  if (!snap) {
    blocks.push(
      h(
        'section',
        { class: 'card' },
        h('h2', null, loading ? 'Buscando tus datos…' : 'Todavía no llegaron datos'),
        h(
          'p',
          { class: 'faint' },
          'Abrí la app en tu PC: manda el resumen al minuto. Si la PC estuvo apagada más de 12 horas, también hace falta abrirla.',
        ),
      ),
    );
  } else {
    if (Date.now() - snap.at > 12 * 3600000)
      blocks.push(
        h(
          'section',
          { class: 'card' },
          h('p', { class: 'faint', style: 'margin:0' }, `Estos datos son de ${ago(snap.at)}. Abrí la app en la PC para actualizarlos.`),
        ),
      );
    blocks.push(
      heroCard(snap),
      pendingCard(snap),
      sentCard(),
      alertsCard(snap),
      buyCard(snap),
      holdingsCard(snap),
      recentCard(snap),
      footer(),
    );
  }
  app.replaceChildren(...blocks.filter(Boolean));
  if (!document.querySelector('.fab'))
    document.body.append(h('button', { class: 'fab', type: 'button', onclick: openAddSheet }, icon(ICON.plus), 'Cargar compra'));
}

readHash();
render();
fetchSnap();
setInterval(() => {
  if (document.visibilityState === 'visible') fetchSnap();
}, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchSnap();
});
window.addEventListener('hashchange', () => {
  readHash();
  render();
  fetchSnap();
});
