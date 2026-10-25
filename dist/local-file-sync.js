import { writeDocumentFile } from './io.js';

function stamp(doc) {
  return {
    revision: doc.revision, width: doc.width, height: doc.height, name: doc.name,
    layers: (doc.layers || []).map(layer => ({
      layer, canvas: layer.canvas, id: layer.id, name: layer.name,
      visible: layer.visible, opacity: layer.opacity, locked: layer.locked, blend: layer.blend,
    })),
  };
}
function sameStamp(a, b) {
  return !!a && !!b && a.revision === b.revision && a.width === b.width && a.height === b.height &&
    a.name === b.name && a.layers.length === b.layers.length && a.layers.every((saved, index) => {
      const other = b.layers[index];
      return saved.layer === other.layer && saved.canvas === other.canvas &&
        ['id', 'name', 'visible', 'opacity', 'locked', 'blend'].every(key => saved[key] === other[key]);
    });
}
function fileError(message, code) { const error = new Error(message); error.code = code; return error; }

/**
 * Debounced, per-document serialized writes. schedule() is safe after every
 * workspace persist: unchanged queued revisions do not restart their debounce.
 * pause() cancels not-yet-started work and awaits writes already in progress.
 * Call await pause() before replacing documents or changing the directory,
 * then a matching resume(). Nested pauses release only after the last resume.
 * flush() retries failures; unfinished editor gestures stay queued.
 */
export function createLocalFileSync({
  getDocs, getDirectory, isEnabled = () => true, canWrite = () => true,
  onStatus = () => {}, writeDocument = writeDocumentFile, delay = 800, retryDelay = 200,
}) {
  if (typeof getDocs !== 'function' || typeof getDirectory !== 'function' || typeof writeDocument !== 'function') {
    throw new TypeError('本地同步缺少工作区或文件写入接口。');
  }
  delay = Number.isFinite(delay) ? Math.max(0, delay) : 800;
  retryDelay = Number.isFinite(retryDelay) ? Math.max(10, retryDelay) : 200;
  let paused = false, pauseDepth = 0, timer = null, epoch = 0, directory = getDirectory();
  let records = new Map(), lastSyncedAt = null, lastDocName = null;
  const running = new Set();
  const docs = () => Array.from(getDocs() || []);
  const usableDirectory = value => value?.kind === 'directory' && typeof value.getFileHandle === 'function' && typeof value.queryPermission === 'function';
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };

  function refreshScope() {
    const next = getDirectory();
    if (next !== directory) {
      clearTimer(); epoch++; directory = next; records = new Map();
      lastSyncedAt = null; lastDocName = null;
    }
    const current = new Set(docs());
    for (const [doc, record] of records) if (!current.has(doc) && !record.running) records.delete(doc);
  }
  function recordFor(doc) {
    let record = records.get(doc);
    if (!record) {
      record = { doc, directory, epoch, pending: false, due: 0, stamp: null, error: null, failedStamp: null, running: null };
      records.set(doc, record);
    }
    return record;
  }
  function getStatus() {
    // Deliberately read-only: UI may call getStatus() while rendering onStatus.
    const currentDocs = docs(), current = new Set(currentDocs), targetDirectory = getDirectory();
    const visibleRecords = [...records.values()].filter(r => current.has(r.doc) && r.directory === targetDirectory && r.epoch === epoch);
    const errors = visibleRecords.filter(r => r.error).map(r => ({
      docId: r.doc.id, docName: r.doc.name, message: r.error.message, code: r.error.code || 'WRITE_FAILED',
    }));
    const syncingRecords = visibleRecords.filter(r => r.running);
    const pending = currentDocs.filter(doc => doc.dirty).length;
    let phase;
    if (paused) phase = 'paused';
    else if (!usableDirectory(targetDirectory)) phase = 'disconnected';
    else if (!isEnabled()) phase = 'disabled';
    else if (syncingRecords.length) phase = 'syncing';
    else if (errors.length) phase = 'error';
    else if (pending) phase = 'pending';
    else phase = 'synced';
    return {
      phase, pending, syncing: syncingRecords.length,
      error: errors[0]?.message || null, code: errors[0]?.code || null, errors,
      lastSyncedAt, docName: syncingRecords[0]?.doc.name || errors[0]?.docName || lastDocName,
    };
  }
  function emit() { try { onStatus(getStatus()); } catch { /* UI callbacks cannot interrupt file writes. */ } }
  function writable(doc) {
    try { return !!canWrite(doc); }
    catch { return false; }
  }
  function activeScope() { return !paused && !!isEnabled() && usableDirectory(directory); }
  function jobCurrent(job) {
    return job.epoch === epoch && getDirectory() === job.directory && docs().includes(job.doc);
  }
  function queue(record, value, due) {
    record.stamp = value; record.pending = true; record.due = due;
  }
  function arm() {
    clearTimer();
    if (!activeScope() || running.size) return;
    const now = Date.now();
    const next = [...records.values()].filter(r => r.pending && !r.running && docs().includes(r.doc))
      .reduce((minimum, r) => Math.min(minimum, r.due), Infinity);
    if (Number.isFinite(next)) timer = setTimeout(() => { timer = null; pump(); }, Math.max(0, next - now));
  }

  function start(record) {
    record.pending = false;
    const job = { doc: record.doc, directory, epoch, stamp: stamp(record.doc) };
    record.stamp = job.stamp;
    let succeeded = false, skipped = false;
    const promise = Promise.resolve().then(async () => {
      // pause() may have run after the timer queued this microtask.
      if (!jobCurrent(job) || paused || !isEnabled()) { skipped = true; return; }
      if (!writable(job.doc)) {
        skipped = true; queue(record, stamp(job.doc), Date.now() + retryDelay); return;
      }
      const result = await writeDocument(job.doc, {
        directory: job.directory,
        isCurrent: () => jobCurrent(job),
        canWrite: () => jobCurrent(job) && writable(job.doc),
        canClean: () => jobCurrent(job) && writable(job.doc),
      });
      if (!jobCurrent(job)) return;
      if (result?.stale || result?.cancelled) { skipped = true; return; }
      if (result?.method !== 'file') throw fileError('自动同步未写入本地文件，请重新授权工作目录后重试。', 'NO_FILE_WRITE');
      succeeded = true;
      record.error = null; record.failedStamp = null;
      lastSyncedAt = Date.now(); lastDocName = result.name || job.doc.name;
      // An old successful snapshot must never clear dirty here. The writer owns
      // its revision/fingerprint acknowledgement; latest edits get another job.
      if (job.doc.dirty) queue(record, stamp(job.doc), Date.now() + (writable(job.doc) ? delay : retryDelay));
    }).catch(error => {
      if (!jobCurrent(job)) return;
      if (error?.code === 'SYNC_CANCELLED') { skipped = true; return; }
      if (error?.code === 'SYNC_BUSY') {
        skipped = true; record.error = null; record.failedStamp = null;
        queue(record, stamp(job.doc), Date.now() + retryDelay); return;
      }
      record.error = error instanceof Error ? error : fileError(String(error), 'WRITE_FAILED');
      record.failedStamp = job.stamp;
      const latest = stamp(job.doc);
      if (job.doc.dirty && !sameStamp(latest, job.stamp)) queue(record, latest, Date.now() + delay);
      else record.pending = false;
    }).finally(() => {
      running.delete(promise); if (record.running === promise) record.running = null;
      if (jobCurrent(job) && !succeeded && !record.error && !skipped && job.doc.dirty && !record.pending) {
        queue(record, stamp(job.doc), Date.now() + delay);
      }
      if (!jobCurrent(job)) {
        // Old tasks cannot publish a success/error against a new workspace.
        refreshScope(); arm(); return;
      }
      if (paused) record.pending = false;
      emit(); arm();
    });
    record.running = promise; running.add(promise);
  }

  function pump(immediate = false) {
    refreshScope();
    if (!activeScope()) { clearTimer(); emit(); return 0; }
    if (running.size) { emit(); return 0; }
    const now = Date.now(), current = new Set(docs());
    let started = 0;
    for (const record of records.values()) {
      if (!record.pending || record.running || !current.has(record.doc)) continue;
      if (!record.doc.dirty) { record.pending = false; record.error = null; record.failedStamp = null; continue; }
      if (!immediate && record.due > now) continue;
      if (!writable(record.doc)) { record.due = now + retryDelay; continue; }
      start(record); started++; break; // Bound composite/PNG memory and serialize file writes globally.
    }
    emit(); arm(); return started;
  }

  function schedule(document = null) {
    refreshScope();
    if (!activeScope()) { clearTimer(); emit(); return getStatus(); }
    const current = docs(), selected = document ? [document] : current;
    const now = Date.now();
    for (const doc of selected) {
      if (!current.includes(doc)) continue;
      const record = recordFor(doc);
      if (!doc.dirty) { record.pending = false; record.error = null; record.failedStamp = null; continue; }
      const latest = stamp(doc);
      if (record.error && sameStamp(record.failedStamp, latest)) continue;
      if (record.error) { record.error = null; record.failedStamp = null; }
      if (sameStamp(record.stamp, latest) && (record.pending || record.running)) continue;
      queue(record, latest, now + delay);
    }
    emit(); arm(); return getStatus();
  }

  async function flush() {
    refreshScope();
    if (!activeScope()) { emit(); return getStatus(); }
    clearTimer();
    // Explicit retry: clear same-revision failure suppression exactly once.
    for (const doc of docs()) {
      const record = recordFor(doc); record.error = null; record.failedStamp = null;
      if (doc.dirty && !record.running) queue(record, stamp(doc), Date.now());
    }
    pump(true);
    for (;;) {
      const inFlight = [...running];
      if (!inFlight.length || paused) break;
      await Promise.allSettled(inFlight);
      if (paused) break;
      // New revisions produced while a previous write ran are flushed in order.
      // Busy editor gestures remain pending; flush never serializes their pixels.
      pump(true);
    }
    arm(); emit(); return getStatus();
  }

  async function pause() {
    pauseDepth++; paused = true; clearTimer();
    for (const record of records.values()) record.pending = false;
    emit();
    // Do not invalidate an already-started write: callers await this barrier
    // before changing workspace identity, and successful files bind only once.
    await Promise.allSettled([...running]);
    emit(); return getStatus();
  }

  function resume() {
    refreshScope();
    if (pauseDepth > 0) pauseDepth--;
    paused = pauseDepth > 0;
    if (paused) { emit(); return getStatus(); }
    for (const record of records.values()) { record.error = null; record.failedStamp = null; }
    return schedule();
  }

  return { schedule, flush, pause, resume, getStatus };
}
