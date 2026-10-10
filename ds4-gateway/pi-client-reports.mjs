// Bounded, durable store for Windows Pi-client sync reports.
// Display-only telemetry: never a routing, admission or model input.
// The route bounds the request body; this module validates the payload and
// owns durability, byte-aware retention and redaction.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const PI_REPORT_STAGES = ['fetch', 'parse', 'merge', 'write', 'validate', 'pi-check'];
const MAX_STEPS = 16;
const MAX_STEPS_BYTES = 4096;
const TOP_KEYS = ['schema', 'revision', 'stage', 'ok', 'error_code', 'error_message', 'client', 'base_url', 'duration_ms', 'steps'];
const CLIENT_KEYS = ['os', 'powershell', 'pi_version'];
const STEP_KEYS = ['stage', 'ok', 'detail'];
// C0 controls and DEL. None of these fields needs a newline, and an unstripped
// control character is a log-injection and terminal-corruption vector.
const CONTROL = /[\u0000-\u001f\u007f]/;

const invalid = message => Object.assign(new Error(message), {code: 'invalid'});
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const cappedString = (value, limit, {nullable = false} = {}) => {
  if (value === null) return nullable ? null : undefined;
  if (typeof value !== 'string' || CONTROL.test(value) || value.length > limit) return undefined;
  return value;
};

// RR4. Applied to free text before storage. Structured fields (base_url) are
// capped but never host-redacted: the dashboard needs them readable.
export function redactPiText(value, redactHosts = []) {
  if (typeof value !== 'string') return value;
  let out = value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')                       // URL userinfo
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')            // bearer fragments
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, 'C:\\Users\\<user>');            // Windows profile
  for (const host of redactHosts) {
    if (typeof host === 'string' && host.length > 0) out = out.split(host).join('<host>');
  }
  return out;
}

function validateStep(input, redactHosts) {
  if (!exactKeys(input, STEP_KEYS)) throw invalid('Each step must carry exactly stage, ok and detail');
  if (!PI_REPORT_STAGES.includes(input.stage)) throw invalid('Unknown step stage');
  if (typeof input.ok !== 'boolean') throw invalid('Step ok must be a boolean');
  const detail = input.detail === null ? null : cappedString(redactPiText(input.detail, redactHosts), 512, {nullable: true});
  if (detail === undefined) throw invalid('Step detail is too long or contains control characters');
  return {stage: input.stage, ok: input.ok, detail};
}

function validateClient(input) {
  if (!exactKeys(input, CLIENT_KEYS)) throw invalid('Client must carry exactly os, powershell and pi_version');
  const os = cappedString(input.os, 64);
  const powershell = cappedString(input.powershell, 64);
  // RR: pi_version is null when pi is not installed on the client.
  const piVersion = input.pi_version === null ? null : cappedString(input.pi_version, 64);
  if (!os) throw invalid('Client os must be a non-empty string');
  if (!powershell) throw invalid('Client powershell must be a non-empty string');
  if (piVersion === undefined) throw invalid('Client pi_version must be a string or null');
  return {os, powershell, pi_version: piVersion};
}

// Returns the validated, redacted, stamped record.
export function validatePiReport(input, {now = () => Date.now(), redactHosts = []} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('A client report must be an object');
  // RR9: the client may not set its own identity or timestamp.
  if (Object.hasOwn(input, 'at') || Object.hasOwn(input, 'report_id')) throw invalid('A client report may not set at or report_id');
  if (!exactKeys(input, TOP_KEYS)) throw invalid('A client report carries an unknown field');
  if (input.schema !== 1) throw invalid('Unsupported client report schema');
  if (!PI_REPORT_STAGES.includes(input.stage)) throw invalid('Unknown report stage');
  if (typeof input.ok !== 'boolean') throw invalid('Report ok must be a boolean');

  const revision = input.revision === null ? null : cappedString(input.revision, 64);
  if (revision === undefined) throw invalid('Report revision is invalid');
  const errorCode = input.error_code === null ? null : cappedString(input.error_code, 64);
  if (errorCode === undefined) throw invalid('Report error_code is invalid');
  const redactedMessage = input.error_message === null ? null : redactPiText(input.error_message, redactHosts);
  const errorMessage = redactedMessage === null ? null : cappedString(redactedMessage, 512, {nullable: true});
  if (errorMessage === undefined) throw invalid('Report error_message is too long or contains control characters');
  const baseUrl = cappedString(input.base_url, 256);
  if (baseUrl === undefined) throw invalid('Report base_url is invalid');
  if (typeof input.duration_ms !== 'number' || !Number.isFinite(input.duration_ms)
    || input.duration_ms < 0 || input.duration_ms > 86400000) throw invalid('Report duration_ms is out of range');

  const steps = input.steps;
  if (!Array.isArray(steps)) throw invalid('Report steps must be an array');
  if (steps.length > MAX_STEPS) throw invalid(`Report steps must contain at most ${MAX_STEPS} entries`);
  const checked = steps.map(step => validateStep(step, redactHosts));
  // RR3: the route caps the whole body, so the steps block must not be able to
  // construct a report the route would reject.
  if (Buffer.byteLength(JSON.stringify(checked)) > MAX_STEPS_BYTES) throw invalid('Report steps exceed the size limit');

  return {
    schema: 1,
    report_id: randomUUID(),
    at: new Date(now()).toISOString(),
    revision,
    stage: input.stage,
    ok: input.ok,
    error_code: errorCode,
    error_message: errorMessage,
    client: validateClient(input.client),
    base_url: baseUrl,
    duration_ms: input.duration_ms,
    steps: checked,
  };
}

export class PiClientReports {
  constructor({now = () => Date.now(), maxEntries = 200, maxBytes = 1048576, file = null, redactHosts = []} = {}) {
    if (typeof now !== 'function') throw new Error('Invalid report clock');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) throw new Error('Invalid report entry limit');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid report byte limit');
    if (file !== null && (typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('Invalid report file path');
    if (!Array.isArray(redactHosts) || redactHosts.some(host => typeof host !== 'string')) throw new Error('Invalid redaction hosts');
    Object.assign(this, {now, maxEntries, maxBytes, file, redactHosts});
    this.entries = [];
    this.bytes = 0;
    this.malformed = 0;
    this.error = null;
    this.loadFailed = false;
    this.load();
  }

  // Refuse to follow a symlink: the report file is written by the gateway and
  // must not be redirectable to another path.
  checkPath() {
    const directory = path.dirname(this.file);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Report directory is not a real directory');
  }

  load() {
    if (!this.file) return;
    try {
      this.checkPath();
      let stat;
      try {
        stat = fs.lstatSync(this.file);
      } catch (error) {
        if (error.code === 'ENOENT') return;   // first report; nothing to load
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Report file is not a regular file');
      const raw = fs.readFileSync(this.file, 'utf8');
      const kept = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          this.malformed++;
          continue;
        }
        if (!value || typeof value !== 'object' || typeof value.report_id !== 'string') {
          this.malformed++;
          continue;
        }
        kept.push(value);
      }
      this.entries = kept.slice(-this.maxEntries);
      this.bytes = this.measure(this.entries);
      this.trim();
    } catch {
      this.error = 'report_store_unreadable';
      this.loadFailed = true;
      this.entries = [];
      this.bytes = 0;
    }
  }

  measure(entries) {
    return entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
  }

  // RR6: retention is byte-aware, not entry-count-only, because
  // maxEntries x a large report can exceed maxBytes.
  trim() {
    while (this.entries.length > this.maxEntries || (this.entries.length > 1 && this.bytes > this.maxBytes)) {
      const dropped = this.entries.shift();
      this.bytes -= Buffer.byteLength(JSON.stringify(dropped)) + 1;
    }
    if (this.bytes < 0) this.bytes = 0;
  }

  // Durable append, synchronous, before returning: a restart cannot lose a
  // report that was acknowledged. Validation failures throw code 'invalid';
  // persistence failures throw without it so the route can answer 503.
  record(input) {
    const row = validatePiReport(input, {now: this.now, redactHosts: this.redactHosts});
    let fd;
    let temporary;
    try {
      if (this.file) {
        this.checkPath();
        try {
          const stat = fs.lstatSync(this.file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Report file is not a regular file');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const line = JSON.stringify(row) + '\n';
        fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
      }
      this.entries.push(row);
      this.bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      this.trim();
      this.error = null;
      // Only compact when retention actually dropped something.
      if (this.file && (this.bytes > this.maxBytes || this.entries.length >= this.maxEntries)) this.compact();
    } catch (error) {
      if (error?.code === 'invalid') throw error;
      this.error = 'report_store_write_failed';
      throw new Error('Client report could not be stored');
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
    }
    return {accepted: true, report_id: row.report_id, at: row.at};
  }

  // Atomic compaction: same-directory temp, fsync, rename over the target.
  compact() {
    if (!this.file) return;
    let temporary;
    try {
      this.checkPath();
      temporary = `${this.file}.${randomUUID()}.tmp`;
      const body = this.entries.map(entry => JSON.stringify(entry)).join('\n') + (this.entries.length ? '\n' : '');
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, body);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      temporary = undefined;
    } catch {
      this.error = 'report_store_compaction_failed';
    } finally {
      if (temporary) try { fs.unlinkSync(temporary); } catch {}
    }
  }

  flush() {
    if (this.file) this.compact();
  }

  snapshot() {
    return {
      schema: 1,
      max_entries: this.maxEntries,
      max_bytes: this.maxBytes,
      retention_bytes: this.bytes,
      malformed_lines: this.malformed,
      persistence_error: this.error,
      reports: this.entries.map(entry => structuredClone(entry)),
    };
  }
}

const displayString = (value, limit) => (typeof value === 'string' && !CONTROL.test(value) && value.length <= limit ? value : null);
const displayNumber = (value, min, max) => (Number.isFinite(value) && value >= min && value <= max ? value : null);

// RR7: display-safe projection. Idempotent, so a double application is a
// no-op and the dashboard may sanitize again without changing the result.
export function piClientForDisplay(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1 || !Array.isArray(raw.reports)) return null;
  const reports = raw.reports.slice(-256).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const reportId = displayString(entry.report_id, 64);
    const at = displayString(entry.at, 64);
    if (!reportId || !at || !Number.isFinite(Date.parse(at))) return [];
    if (!PI_REPORT_STAGES.includes(entry.stage) || typeof entry.ok !== 'boolean') return [];
    const client = entry.client && typeof entry.client === 'object' && !Array.isArray(entry.client)
      ? {
        os: displayString(entry.client.os, 64),
        powershell: displayString(entry.client.powershell, 64),
        pi_version: entry.client.pi_version === null ? null : displayString(entry.client.pi_version, 64),
      }
      : null;
    if (!client || !client.os || !client.powershell) return [];
    const steps = Array.isArray(entry.steps)
      ? entry.steps.slice(0, MAX_STEPS).flatMap(step => (
        step && PI_REPORT_STAGES.includes(step.stage) && typeof step.ok === 'boolean'
          ? [{stage: step.stage, ok: step.ok, detail: step.detail === null ? null : displayString(step.detail, 512)}]
          : []
      ))
      : [];
    return [{
      schema: 1,
      report_id: reportId,
      at,
      revision: entry.revision === null ? null : displayString(entry.revision, 64),
      stage: entry.stage,
      ok: entry.ok,
      error_code: entry.error_code === null ? null : displayString(entry.error_code, 64),
      error_message: entry.error_message === null ? null : displayString(entry.error_message, 512),
      client,
      base_url: displayString(entry.base_url, 256),
      duration_ms: displayNumber(entry.duration_ms, 0, 86400000),
      steps,
    }];
  });
  return {
    schema: 1,
    malformed_lines: Number.isSafeInteger(raw.malformed_lines) && raw.malformed_lines >= 0 ? raw.malformed_lines : 0,
    persistence_error: displayString(raw.persistence_error, 64),
    reports,
  };
}
