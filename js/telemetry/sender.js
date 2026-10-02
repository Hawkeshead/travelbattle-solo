/* =========================================================
   MATCH TELEMETRY: THE WRITE PATH (build spec section 3)

   Browser only (the simulator never loads this). Shows nothing to the player
   and never blocks the game: everything here is asynchronous and every
   failure is swallowed.

   - After every turn the live record is checkpointed to IndexedDB, so if the
     page dies mid-match the next load finds it, marks it 'incomplete',
     finishes what it can and queues it.
   - At match end the finished record goes into an outbox (IndexedDB, keyed by
     matchUid) and the checkpoint is cleared.
   - The outbox is flushed on page load, when the phone comes back online, and
     after every match: it signs in to Supabase the way online play does (the
     same session; anonymous if there is none) and calls
     public.submit_match_record. 'inserted', 'upgraded' or 'duplicate' all
     remove the entry. A network or server failure leaves it, with a back-off
     of 1, 5 and 30 minutes, then hourly. A validation error (4xx) moves it to
     the rejected store, never retried, and is noted as a diagnostic flag on
     the next match's record.

   IndexedDB rather than localStorage: a record can approach 1 MB and
   localStorage holds about 5 MB per site.
========================================================= */
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '../online-config.js';
import { currentRecord, onRecorderCheckpoint, onRecorderFinalised, recNote, recoverIncomplete } from './recorder.js';

const DB_NAME = 'fc_telemetry', DB_VERSION = 1;
const OUTBOX = 'fc_telemetry_outbox', REJECTED = 'fc_telemetry_rejected', LIVE = 'fc_live', LIVE_KEY = 'fc_live_record';
const BACKOFF_MIN = [1, 5, 30, 60];

let dbPromise = null;
function db(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((ok, no) => {
    if(typeof indexedDB === 'undefined'){ no(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if(!d.objectStoreNames.contains(OUTBOX)) d.createObjectStore(OUTBOX, { keyPath: 'matchUid' });
      if(!d.objectStoreNames.contains(REJECTED)) d.createObjectStore(REJECTED, { keyPath: 'matchUid' });
      if(!d.objectStoreNames.contains(LIVE)) d.createObjectStore(LIVE);
    };
    req.onsuccess = () => ok(req.result);
    req.onerror = () => no(req.error);
  });
  return dbPromise;
}
async function tx(store, mode, fn){
  const d = await db();
  return new Promise((ok, no) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const res = fn(s);
    t.oncomplete = () => ok(res && 'result' in res ? res.result : undefined);
    t.onerror = () => no(t.error);
    t.onabort = () => no(t.error);
  });
}
const put = (store, value, key) => tx(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
const get = (store, key) => tx(store, 'readonly', s => s.get(key));
const all = store => tx(store, 'readonly', s => s.getAll());

/* ---------- the connection: the same Supabase session online play uses ---------- */
let client = null;
async function supabase(){
  // A test can swap the transport (window.__fcTelemetryTransport) for one that
  // never touches the network.
  if(typeof window !== 'undefined' && window.__fcTelemetryTransport) return window.__fcTelemetryTransport;
  if(client) return client;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  client = {
    async submit(record){
      const { data: { session } } = await sb.auth.getSession();
      if(!session){ const { error } = await sb.auth.signInAnonymously(); if(error) throw Object.assign(new Error(error.message), { network: true }); }
      const { data, error, status } = await sb.rpc('submit_match_record', { record });
      if(error) throw Object.assign(new Error(error.message || 'rpc failed'), { status, code: error.code });
      return data;
    },
  };
  return client;
}

/* ---------- flushing the outbox ---------- */
let flushing = false;
/* force: try everything now, back-off or not (page load, back online). */
export async function flushOutbox(force = false){
  if(flushing) return;
  flushing = true;
  try {
    const items = await all(OUTBOX);
    const now = Date.now();
    for(const item of items){
      if(!force && item.nextTryAt && item.nextTryAt > now) continue;
      let result = null, err = null;
      try { result = await (await supabase()).submit(item.record); } catch(e){ err = e; }
      if(!err && ['inserted', 'upgraded', 'duplicate'].includes(result)){ await del(OUTBOX, item.matchUid); continue; }
      const status = err && err.status;
      const validation = err && status >= 400 && status < 500 && !/rate limit/i.test(err.message || '') && status !== 401 && status !== 408 && status !== 429;
      if(validation){
        await put(REJECTED, { matchUid: item.matchUid, record: item.record, error: String(err.message || err), at: new Date().toISOString() });
        await del(OUTBOX, item.matchUid);
        recNote({ code: 'TELEMETRY_REJECTED', turn: null, unit: null, text: `match ${item.matchUid} was rejected by the server: ${String(err.message || err).slice(0, 160)}` });
        continue;
      }
      const attempts = (item.attempts || 0) + 1;
      await put(OUTBOX, Object.assign(item, { attempts, nextTryAt: now + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60000,
        lastError: String((err && err.message) || result || 'unknown') }));
    }
  } catch(_e){ /* IndexedDB unavailable: nothing to do */ }
  finally { flushing = false; }
}

/* Puts a record in the outbox (the viewer's "Re-send" uses this too). */
export async function queueRecord(record){
  if(!record || !record.matchUid) return;
  try { await put(OUTBOX, { matchUid: record.matchUid, record: JSON.parse(JSON.stringify(record)), attempts: 0, nextTryAt: 0, queuedAt: new Date().toISOString() }); }
  catch(_e){ /* nothing more to be done */ }
}
export async function resendCurrent(){
  const r = currentRecord();
  if(!r || !r.endedAt) return false;
  await queueRecord(r);
  flushOutbox();
  return true;
}

/* ---------- start-up ---------- */
export async function initTelemetrySender(){
  onRecorderCheckpoint(rec => { put(LIVE, JSON.parse(JSON.stringify(rec)), LIVE_KEY).catch(() => {}); });
  onRecorderFinalised(async rec => {
    try { await queueRecord(rec); await del(LIVE, LIVE_KEY); } catch(_e){ /* ignore */ }
    flushOutbox();
  });
  // A match the page died in the middle of: finish it as 'incomplete' and queue it.
  try {
    const live = await get(LIVE, LIVE_KEY);
    if(live && live.matchUid){
      const done = recoverIncomplete(live);
      await queueRecord(done);
      await del(LIVE, LIVE_KEY);
    }
  } catch(_e){ /* ignore */ }
  if(typeof window !== 'undefined') window.addEventListener('online', () => flushOutbox(true));
  flushOutbox(true);
}
