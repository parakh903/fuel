// Fetches live prices from the NSW Fuel API, appends to prices.json, sends ntfy alerts.
// Secrets come from environment variables only: FUEL_API_KEY, FUEL_API_SECRET, NTFY_TOPIC (optional).
const fs = require('fs');
const crypto = require('crypto');

const API = process.env.FUEL_API_BASE || 'https://api.onegov.nsw.gov.au';
const NTFY = process.env.NTFY_BASE || 'https://ntfy.sh';
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const key = process.env.FUEL_API_KEY, secret = process.env.FUEL_API_SECRET, topic = process.env.NTFY_TOPIC;
const HOUR = 3600e3, DAY = 24 * HOUR;

async function retry(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= 2) throw e; await new Promise(r => setTimeout(r, 4000 * (i + 1))); }
  }
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  const h = d.getUTCHours() % 12 || 12, ap = d.getUTCHours() < 12 ? 'AM' : 'PM';
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(h)}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${ap}`;
}

async function fetchPrices() {
  if (!key || !secret) throw new Error('Missing FUEL_API_KEY or FUEL_API_SECRET');
  const basic = Buffer.from(key + ':' + secret).toString('base64');
  const tr = await retry(async () => {
    const r = await fetch(API + '/oauth/client_credential/accesstoken?grant_type=client_credentials', { headers: { Authorization: 'Basic ' + basic } });
    if (r.status >= 500) throw new Error('token ' + r.status);
    return r;
  });
  if (!tr.ok) throw new Error('Token request failed: ' + tr.status);
  const token = (await tr.json()).access_token;
  if (!token) throw new Error('No access token returned');
  const j = await retry(async () => {
    const r = await fetch(API + '/FuelPriceCheck/v1/fuel/prices', {
      headers: { Authorization: 'Bearer ' + token, apikey: key, transactionid: crypto.randomUUID(), requesttimestamp: stamp(new Date()) }
    });
    if (r.status >= 500) throw new Error('prices ' + r.status);
    if (!r.ok) throw new Error('Prices request failed: ' + r.status);
    return r.json();
  });
  const p = {};
  (j.prices || []).forEach(x => {
    const c = String(x.stationcode), v = Number(x.price);
    if (x.fueltype === cfg.fuelType && cfg.stations[c] && v > 100 && v < 400) p[c] = v;
  });
  return p;
}

const cheapest = s => Math.min.apply(null, Object.values(s.p));
const cheapName = s => { const m = cheapest(s); const c = Object.keys(s.p).find(k => s.p[k] === m); return cfg.stations[c]; };

async function notify(title, body, tags, priority) {
  if (!topic) { console.log('ntfy topic not set, skipping alert:', title); return; }
  try {
    const r = await fetch(NTFY + '/' + encodeURIComponent(topic), {
      method: 'POST',
      headers: { Title: title, Tags: tags, Priority: String(priority), Click: cfg.pageUrl },
      body
    });
    console.log('ntfy sent:', title, r.status);
  } catch (e) { console.log('ntfy failed:', e.message); }
}

(async () => {
  const now = new Date();
  const p = await fetchPrices();
  const found = Object.keys(p).length;
  console.log('Got', found, 'of', Object.keys(cfg.stations).length, 'stations');
  if (!found) throw new Error('No prices for tracked stations; not writing');

  let data = { h: [], alerts: {} };
  try { data = JSON.parse(fs.readFileSync('prices.json', 'utf8')); } catch (e) {}
  data.h = data.h || []; data.alerts = data.alerts || {};
  data.h.push({ t: now.toISOString(), p });
  const cut = now.getTime() - cfg.keepDays * DAY;
  data.h = data.h.filter(s => new Date(s.t).getTime() >= cut);
  data.updated = now.toISOString();

  const a = cfg.alerts, cur = data.h[data.h.length - 1], prev = data.h[data.h.length - 2];
  const win = data.h.filter(s => new Date(s.t).getTime() >= now.getTime() - a.windowDays * DAY);
  const vals = win.map(cheapest), mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), c = cheapest(cur);
  const spanDays = (now - new Date(win[0].t)) / DAY;
  const cool = k => !data.alerts[k] || now - new Date(data.alerts[k]) >= a.cooldownHours * HOUR;

  console.log(`Cheapest ${c}c (${cheapName(cur)}); ${a.windowDays}d range ${mn}-${mx}c; ${spanDays.toFixed(1)} days of history`);

  if (spanDays >= a.minDays && mx - mn >= 5) {
    const pos = (c - mn) / (mx - mn), pp = prev ? (cheapest(prev) - mn) / (mx - mn) : 1;
    if (pos <= a.lowZone && (pp > a.lowZone || !data.alerts.low) && cool('low')) {
      await notify('Fuel: bottom of the cycle',
        `Cheapest 91 is ${c.toFixed(1)}c/L at ${cheapName(cur)}. Lowest ${Math.round(a.lowZone * 100)}% of the last ${a.windowDays} days (${mn}-${mx}c). Good time to fill.`,
        'fuelpump,chart_with_downwards_trend', 4);
      data.alerts.low = now.toISOString();
    }
  }
  const ref = data.h.filter(s => { const age = now - new Date(s.t); return age >= 18 * HOUR && age <= 30 * HOUR; })
    .sort((x, y) => Math.abs(now - new Date(x.t) - DAY) - Math.abs(now - new Date(y.t) - DAY))[0];
  if (ref) {
    const rise = c - cheapest(ref);
    if (rise >= a.riseCents && cool('rise')) {
      await notify('Fuel: prices rising sharply',
        `Cheapest 91 is up ${rise.toFixed(1)}c in about 24h, now ${c.toFixed(1)}c/L at ${cheapName(cur)}. Fill soon if you need fuel.`,
        'warning,chart_with_upwards_trend', 3);
      data.alerts.rise = now.toISOString();
    }
  }
  fs.writeFileSync('prices.json', JSON.stringify(data));
  console.log('Saved', data.h.length, 'snapshots');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
