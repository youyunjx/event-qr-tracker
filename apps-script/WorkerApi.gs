/**
 * JSON endpoints for the Cloudflare Worker redirector (see worker/). Both require ?key=WORKER_KEY (Config.gs).
 *
 *   ?api=campaigns&key=…          {"campaigns": {"<slug>": {"url": "https://…", "active": true}}}
 *   ?api=log&e=<slug>&key=…       logs one scan with the campaign's name and source → {"ok": true}
 *
 * The Worker redirects visitors instantly and calls the log endpoint in the background.
 */

function handleWorkerApi_(p) {
  if (typeof WORKER_KEY === 'undefined' || !WORKER_KEY || p.key !== WORKER_KEY) {
    return json_({ error: 'forbidden' });
  }

  if (p.api === 'campaigns') {
    const all = getCampaigns_();
    const out = {};
    Object.keys(all).forEach(function (slug) {
      const c = all[slug];
      const safe = isSafeUrl_(c.url);
      out[slug] = { url: safe ? c.url : '', active: c.active && safe };
    });
    return json_({ campaigns: out });
  }

  if (p.api === 'log') {
    const slug = normalizeSlug_(p.e);
    const campaign = slug ? getCampaign_(slug) : null;
    if (!campaign || !campaign.active) return json_({ ok: false, reason: 'unknown or inactive' });
    logScan_(slug, campaign.name, campaign.source);
    return json_({ ok: true });
  }

  return json_({ error: 'unknown api' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
