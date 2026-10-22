/**
 * Event QR Tracker – instant redirector (Cloudflare Worker)
 *
 *   https://<worker>.workers.dev/<slug>  →  302 to the campaign's destination_url, no tap needed
 *
 * Campaigns come from the Apps Script web app (?api=campaigns), cached in memory for CACHE_MS.
 * Each visit is logged in the background (?api=log), so the redirect never waits for Google.
 * If the Apps Script can't be reached, visitors fall back to the Apps Script "Continue to site" page
 * (which logs the scan itself), so nobody gets stuck.
 */

const SLUG_PATTERN = /^[a-z0-9_-]{1,64}$/;
const CACHE_MS = 60 * 1000; // campaign edits show up within a minute
const MAX_STALE_MS = 10 * 60 * 1000; // older than this, wait for fresh data instead
const RECHECK_UNKNOWN_MS = 5 * 1000; // an unknown slug triggers a refetch (new campaign) at most this often
// Link-preview fetchers (chat apps, social sites) still get redirected but aren't counted as visits.
const PREVIEW_BOTS = /bot\b|crawler|spider|facebookexternalhit|whatsapp|slack|telegram|discord|linkedin|skype|embedly|vkshare|preview/i;

let cache = null; // { at: ms, campaigns: { slug: { url, active } } }
let refreshing = null;

export default {
  async fetch(request, env, ctx) {
    let slug = '';
    try {
      slug = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+|\/+$/g, '').trim().toLowerCase();
    } catch (err) {
      // malformed %-encoding
    }
    if (!SLUG_PATTERN.test(slug)) return inactivePage();

    let campaigns;
    try {
      campaigns = await getCampaigns(env, ctx, slug);
    } catch (err) {
      console.error('Campaign lookup failed:', err);
      return redirect(`${env.APPS_SCRIPT_URL}?e=${encodeURIComponent(slug)}`); // fallback page logs the scan
    }

    const campaign = campaigns[slug];
    if (!campaign || !campaign.active || !/^https?:\/\//i.test(campaign.url)) return inactivePage();

    const ua = request.headers.get('user-agent') || '';
    if (request.method === 'GET' && !PREVIEW_BOTS.test(ua)) {
      ctx.waitUntil(logScan(env, slug));
    }
    return redirect(campaign.url);
  },
};

async function getCampaigns(env, ctx, slug) {
  const age = cache ? Date.now() - cache.at : Infinity;
  const missing = cache && !(slug in cache.campaigns);
  if (cache && age < CACHE_MS && !(missing && age > RECHECK_UNKNOWN_MS)) return cache.campaigns;
  if (cache && age < MAX_STALE_MS && !missing) {
    ctx.waitUntil(refresh(env)); // serve slightly stale data now, refresh in the background
    return cache.campaigns;
  }
  await refresh(env, true);
  return cache.campaigns;
}

function refresh(env, mustSucceed) {
  if (!refreshing) {
    refreshing = fetchCampaigns(env)
      .then((campaigns) => { cache = { at: Date.now(), campaigns }; })
      .finally(() => { refreshing = null; });
  }
  return mustSucceed ? refreshing : refreshing.catch((err) => console.error('Background refresh failed:', err));
}

async function fetchCampaigns(env) {
  const res = await fetch(`${env.APPS_SCRIPT_URL}?api=campaigns&key=${encodeURIComponent(env.WORKER_KEY)}`);
  if (!res.ok) throw new Error(`campaigns HTTP ${res.status}`);
  const data = await res.json();
  if (!data || typeof data.campaigns !== 'object') throw new Error(`unexpected response: ${JSON.stringify(data).slice(0, 200)}`);
  return data.campaigns;
}

async function logScan(env, slug) {
  try {
    const res = await fetch(`${env.APPS_SCRIPT_URL}?api=log&e=${encodeURIComponent(slug)}&key=${encodeURIComponent(env.WORKER_KEY)}`);
    const data = await res.json();
    if (!data.ok) console.warn('Scan not logged:', slug, JSON.stringify(data));
  } catch (err) {
    console.error('Logging failed:', slug, err);
  }
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

function inactivePage() {
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Code not active</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:48px 24px;' +
    'text-align:center;color:#222}h1{font-size:1.4em;margin:0 0 .5em}p{color:#555}</style></head><body>' +
    '<h1>This code is no longer active</h1><p>Thanks for scanning. This event link has ended or is not available.</p></body></html>';
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
