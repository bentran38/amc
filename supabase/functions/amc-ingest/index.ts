// Receives what the scraper (scraper/scrape.js, run on a schedule from a PC) read off amctheatres.com and stores it
// with amc.ingest(). The scraper only holds AMC_INGEST_TOKEN, a secret good for nothing but this function, so the
// Supabase service-role key never leaves Supabase. verify_jwt is off: the token is the check.
//
//   POST { action: 'targets' }          -> { theatres: [{ id, slug, market, tz, want_days }] }   what to scrape
//   POST { action: 'ingest', run: {...} } -> { showtimes, pruned }                     see amc.ingest() for the shape
import { createClient } from 'npm:@supabase/supabase-js@2';

const TOKEN = Deno.env.get('AMC_INGEST_TOKEN') ?? '';
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Constant-time string compare, so the token can't be guessed a character at a time. */
function same(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  if (TOKEN.length < 32) return json(503, { error: 'AMC_INGEST_TOKEN is not set up' });
  if (!same(req.headers.get('x-ingest-token') ?? '', TOKEN)) return json(401, { error: 'Bad token' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'Invalid JSON' }); }

  if (body.action === 'targets') {
    const { data, error } = await db.schema('amc').from('theatres')
      .select('id, slug, market, tz').eq('scrape', true).not('slug', 'is', null).not('market', 'is', null);
    if (error) return json(500, { error: error.message });
    // days with plans or pencil marks that haven't been read lately: the scraper reads these first
    const wants = await db.schema('amc').rpc('scrape_wants');
    if (wants.error) return json(500, { error: wants.error.message });
    const theatres = data.map((t) => ({ ...t, want_days: (wants.data ?? []).filter((w) => w.theatre_id === t.id).map((w) => w.day) }));
    return json(200, { theatres });
  }

  if (body.action === 'ingest') {
    const run = body.run;
    if (!run || typeof run !== 'object') return json(400, { error: 'Send run' });
    if (JSON.stringify(run).length > 5_000_000) return json(413, { error: 'Too big' });
    const { data, error } = await db.schema('amc').rpc('ingest', { p: run });
    if (error) return json(500, { error: error.message });
    return json(200, data);
  }

  return json(400, { error: 'Unknown action' });
});
