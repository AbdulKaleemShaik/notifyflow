// packages/proto/index.js
// Shared encode/decode helpers for all NotifyFlow services.
// Uses protobufjs dynamic API — no code-generation step required.
//
// Usage:
//   import { encodeJobPayload, decodeJobPayload, encodeWsMessage, decodeWsMessage }
//     from '@notifyflow/proto';

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import protobuf from 'protobufjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_FILE = path.join(__dirname, 'notification.proto');

// ─── Load .proto once at module initialisation ────────────────────────────────
// protobufjs.load() is async; we expose a ready promise so callers that need
// to await initialisation can do so. In practice each service calls one of the
// helper functions which all await the same promise — no double-loading occurs.

let _JobPayload;
let _WsMessage;

const _ready = protobuf.load(PROTO_FILE).then((root) => {
  _JobPayload = root.lookupType('notifyflow.JobPayload');
  _WsMessage  = root.lookupType('notifyflow.WsMessage');
});

async function ensureLoaded() {
  await _ready;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an arbitrary plain-object `data` field into a flat map<string,string>.
 * String values are kept as-is; everything else is JSON-stringified.
 * @param {object} data
 * @returns {Record<string, string>}
 */
function flattenData(data = {}) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * Reverse flattenData — attempt to JSON.parse each value; fall back to the raw
 * string if parsing fails.
 * @param {Record<string, string>} flat
 * @returns {object}
 */
function unflattenData(flat = {}) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// JobPayload — API ➜ Worker (via BullMQ)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a job payload object to a protobuf Buffer.
 *
 * @param {object} payload
 * @param {string} payload.notificationLogId
 * @param {string} payload.tenantId
 * @param {string} payload.userId
 * @param {string} payload.channel
 * @param {string} payload.templateName
 * @param {string} [payload.tenantSecret]
 * @param {string} [payload.webhookUrl]
 * @param {string} [payload.userEmail]
 * @param {object} [payload.data]
 * @returns {Promise<Buffer>}
 */
export async function encodeJobPayload(payload) {
  await ensureLoaded();

  const msg = {
    notificationLogId: payload.notificationLogId ?? '',
    tenantId:          payload.tenantId          ?? '',
    userId:            payload.userId             ?? '',
    channel:           payload.channel            ?? '',
    templateName:      payload.templateName       ?? '',
    tenantSecret:      payload.tenantSecret       ?? '',
    webhookUrl:        payload.webhookUrl          ?? '',
    userEmail:         payload.userEmail           ?? '',
    data:              flattenData(payload.data),
  };

  const errMsg = _JobPayload.verify(msg);
  if (errMsg) throw new Error(`[proto] JobPayload verify failed: ${errMsg}`);

  return Buffer.from(_JobPayload.encode(_JobPayload.create(msg)).finish());
}

/**
 * Decode a protobuf Buffer back to a plain job payload object.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {Promise<object>}
 */
export async function decodeJobPayload(buf) {
  await ensureLoaded();
  const msg = _JobPayload.decode(buf instanceof Buffer ? buf : Buffer.from(buf));
  const obj = _JobPayload.toObject(msg, { defaults: true });

  return {
    notificationLogId: obj.notificationLogId,
    tenantId:          obj.tenantId,
    userId:            obj.userId,
    channel:           obj.channel,
    templateName:      obj.templateName,
    tenantSecret:      obj.tenantSecret,
    webhookUrl:        obj.webhookUrl,
    userEmail:         obj.userEmail,
    data:              unflattenData(obj.data),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WsMessage — Worker ➜ WS-Server (via Redis Pub/Sub)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a WebSocket notification message to a protobuf Buffer.
 *
 * @param {object} payload
 * @param {string} payload.type
 * @param {string} [payload.notificationId]
 * @param {string} [payload.templateName]
 * @param {string} [payload.body]
 * @param {object} [payload.data]
 * @param {string} [payload.timestamp]
 * @returns {Promise<Buffer>}
 */
export async function encodeWsMessage(payload) {
  await ensureLoaded();

  const msg = {
    type:           payload.type           ?? '',
    notificationId: payload.notificationId ?? '',
    templateName:   payload.templateName   ?? '',
    body:           payload.body           ?? '',
    timestamp:      payload.timestamp      ?? new Date().toISOString(),
    data:           flattenData(payload.data),
  };

  const errMsg = _WsMessage.verify(msg);
  if (errMsg) throw new Error(`[proto] WsMessage verify failed: ${errMsg}`);

  return Buffer.from(_WsMessage.encode(_WsMessage.create(msg)).finish());
}

/**
 * Decode a protobuf Buffer back to a plain WsMessage object.
 * The returned object is safe to JSON.stringify for the browser.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {Promise<object>}
 */
export async function decodeWsMessage(buf) {
  await ensureLoaded();
  const msg = _WsMessage.decode(buf instanceof Buffer ? buf : Buffer.from(buf));
  const obj = _WsMessage.toObject(msg, { defaults: true });

  return {
    type:           obj.type,
    notificationId: obj.notificationId,
    templateName:   obj.templateName,
    body:           obj.body,
    timestamp:      obj.timestamp,
    data:           unflattenData(obj.data),
  };
}
