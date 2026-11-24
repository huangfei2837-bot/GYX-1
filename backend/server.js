"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const mqtt = require("mqtt");

const HOST = process.env.GYX1_HOST || "0.0.0.0";
const PORT = Number(process.env.GYX1_PORT || 8080);
const ONLINE_TIMEOUT_MS = Number(process.env.GYX1_ONLINE_TIMEOUT_MS || 15000);
const ALLOWED_ORIGIN = process.env.GYX1_ALLOWED_ORIGIN || "*";
const DB_PATH = process.env.GYX1_DB || path.join(__dirname, "gyx1.sqlite");
const FRONTEND_DIR = path.resolve(__dirname, "..");
const MQTT_URL = process.env.GYX1_MQTT_URL || "";
const MQTT_TOPIC = process.env.GYX1_MQTT_TOPIC || "gyx1/+/telemetry";
const MQTT_CLIENT_ID = process.env.GYX1_MQTT_CLIENT_ID || `gyx1-backend-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    sequence INTEGER,
    timestamp TEXT NOT NULL,
    adc_raw REAL,
    vout REAL NOT NULL,
    vc REAL,
    vref REAL,
    heater_voltage REAL,
    heater_current REAL,
    temperature REAL NOT NULL,
    humidity REAL NOT NULL,
    heater_stage TEXT,
    warmup_complete INTEGER,
    fault_code INTEGER NOT NULL DEFAULT 0,
    firmware_version TEXT,
    computed_ppm REAL,
    ai_probability REAL,
    model_version TEXT,
    interval REAL NOT NULL DEFAULT 1,
    lost_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_telemetry_device_time ON telemetry(device_id, timestamp DESC);
  CREATE TABLE IF NOT EXISTS device_stats (
    device_id TEXT PRIMARY KEY,
    last_sequence INTEGER,
    lost_count INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL,
    firmware_version TEXT,
    fault_code INTEGER NOT NULL DEFAULT 0
  );
`);

const statements = {
  getStats: db.prepare("SELECT * FROM device_stats WHERE device_id = ?"),
  upsertStats: db.prepare(`
    INSERT INTO device_stats(device_id, last_sequence, lost_count, last_seen, firmware_version, fault_code)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      last_sequence=excluded.last_sequence,
      lost_count=excluded.lost_count,
      last_seen=excluded.last_seen,
      firmware_version=excluded.firmware_version,
      fault_code=excluded.fault_code
  `),
  insertTelemetry: db.prepare(`
    INSERT INTO telemetry(
      device_id, sequence, timestamp, adc_raw, vout, vc, vref,
      heater_voltage, heater_current, temperature, humidity, heater_stage,
      warmup_complete, fault_code, firmware_version, computed_ppm,
      ai_probability, model_version, interval, lost_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getById: db.prepare("SELECT * FROM telemetry WHERE id = ?"),
  latest: db.prepare("SELECT * FROM telemetry WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1"),
  history: db.prepare("SELECT * FROM telemetry WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?"),
  listDevices: db.prepare("SELECT * FROM device_stats ORDER BY device_id")
};

const websocketClients = new Set();
let mqttClient = null;
const mqttState = {
  enabled: Boolean(MQTT_URL),
  connected: false,
  broker: MQTT_URL ? safeBrokerName(MQTT_URL) : null,
  topic: MQTT_URL ? MQTT_TOPIC : null,
  last_message_at: null,
  last_error: null,
  received_count: 0,
  rejected_count: 0
};

function safeBrokerName(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch (_) {
    return "configured";
  }
}

function publicMqttState() {
  return { ...mqttState };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("请求内容超过1MB"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (_) { reject(new Error("JSON格式无效")); }
    });
    req.on("error", reject);
  });
}

function numberValue(value, field, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`缺少字段 ${field}`);
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field}不是有效数字`);
  return number;
}

function valueFrom(payload, snake, camel = snake) {
  return payload[snake] ?? payload[camel];
}

function normalizeTelemetry(payload) {
  const deviceId = String(valueFrom(payload, "device_id", "deviceId") || "").trim();
  if (!deviceId || deviceId.length > 80) throw new Error("device_id不能为空且不能超过80个字符");
  const timestampInput = payload.timestamp ? new Date(payload.timestamp) : new Date();
  if (Number.isNaN(timestampInput.getTime())) throw new Error("timestamp格式无效");
  const humidity = numberValue(payload.humidity, "humidity", true);
  if (humidity < 0 || humidity > 100) throw new Error("humidity必须在0到100之间");
  const aiProbability = numberValue(valueFrom(payload, "ai_probability", "aiProbability"), "ai_probability");
  if (aiProbability !== null && (aiProbability < 0 || aiProbability > 1)) throw new Error("ai_probability必须在0到1之间");
  return {
    device_id: deviceId,
    sequence: numberValue(payload.sequence, "sequence"),
    timestamp: timestampInput.toISOString(),
    adc_raw: numberValue(valueFrom(payload, "adc_raw", "adcRaw"), "adc_raw"),
    vout: numberValue(payload.vout, "vout", true),
    vc: numberValue(payload.vc, "vc"),
    vref: numberValue(payload.vref, "vref"),
    heater_voltage: numberValue(valueFrom(payload, "heater_voltage", "heaterVoltage"), "heater_voltage") ?? 0,
    heater_current: numberValue(valueFrom(payload, "heater_current", "heaterCurrent"), "heater_current") ?? 0,
    temperature: numberValue(payload.temperature, "temperature", true),
    humidity,
    heater_stage: String(valueFrom(payload, "heater_stage", "heaterStage") || "stable").slice(0, 40),
    warmup_complete: Boolean(valueFrom(payload, "warmup_complete", "warmupComplete")),
    fault_code: Math.max(0, Math.trunc(numberValue(valueFrom(payload, "fault_code", "faultCode"), "fault_code") ?? 0)),
    firmware_version: String(valueFrom(payload, "firmware_version", "firmwareVersion") || "--").slice(0, 80),
    computed_ppm: numberValue(valueFrom(payload, "computed_ppm", "computedPpm"), "computed_ppm"),
    ai_probability: aiProbability,
    model_version: String(valueFrom(payload, "model_version", "modelVersion") || "").slice(0, 80) || null,
    interval: Math.max(0.01, numberValue(payload.interval, "interval") ?? 1)
  };
}

function insertTelemetry(payload) {
  const data = normalizeTelemetry(payload);
  const prior = statements.getStats.get(data.device_id);
  const priorSequence = prior?.last_sequence;
  const lostCount = (prior?.lost_count || 0) + (
    data.sequence !== null && priorSequence !== null && priorSequence !== undefined && data.sequence > priorSequence + 1
      ? data.sequence - priorSequence - 1 : 0
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    statements.upsertStats.run(data.device_id, data.sequence, lostCount, data.timestamp, data.firmware_version, data.fault_code);
    const result = statements.insertTelemetry.run(
      data.device_id, data.sequence, data.timestamp, data.adc_raw, data.vout, data.vc, data.vref,
      data.heater_voltage, data.heater_current, data.temperature, data.humidity, data.heater_stage,
      data.warmup_complete ? 1 : 0, data.fault_code, data.firmware_version, data.computed_ppm,
      data.ai_probability, data.model_version, data.interval, lostCount
    );
    db.exec("COMMIT");
    return statements.getById.get(result.lastInsertRowid);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function deviceView(row) {
  const lastSeenMs = Date.parse(row.last_seen);
  const latest = statements.latest.get(row.device_id) || null;
  return {
    device_id: row.device_id,
    online: Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= ONLINE_TIMEOUT_MS,
    last_seen: row.last_seen,
    last_sequence: row.last_sequence,
    lost_count: row.lost_count,
    firmware_version: row.firmware_version,
    fault_code: row.fault_code,
    latest
  };
}

function websocketFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function broadcastTelemetry(record) {
  const frame = websocketFrame({ type: "telemetry", data: record });
  for (const client of websocketClients) {
    if (client.deviceId === record.device_id && !client.socket.destroyed) {
      try { client.socket.write(frame); } catch (_) { websocketClients.delete(client); }
    }
  }
}

function deviceIdFromTelemetryTopic(topic) {
  const parts = String(topic).split("/");
  return parts.length === 3 && parts[0] === "gyx1" && parts[2] === "telemetry" ? parts[1] : null;
}

function acceptMqttTelemetry(topic, message) {
  if (message.length > 1024 * 1024) throw new Error("MQTT消息超过1MB");
  let payload;
  try { payload = JSON.parse(message.toString("utf8")); }
  catch (_) { throw new Error("MQTT消息不是有效JSON"); }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("MQTT消息必须是JSON对象");

  const topicDeviceId = deviceIdFromTelemetryTopic(topic);
  if (!topicDeviceId) throw new Error("MQTT主题格式无效");
  const payloadDeviceId = String(valueFrom(payload, "device_id", "deviceId") || "").trim();
  if (payloadDeviceId && payloadDeviceId !== topicDeviceId) throw new Error("设备编号与MQTT主题不一致");
  payload.device_id = topicDeviceId;

  const record = insertTelemetry(payload);
  broadcastTelemetry(record);
  mqttState.received_count += 1;
  mqttState.last_message_at = record.timestamp;
  mqttState.last_error = null;
  return record;
}

function startMqtt() {
  if (!MQTT_URL) {
    console.log("MQTT ingest disabled: GYX1_MQTT_URL is not set");
    return;
  }
  mqttClient = mqtt.connect(MQTT_URL, {
    username: process.env.GYX1_MQTT_USERNAME,
    password: process.env.GYX1_MQTT_PASSWORD,
    clientId: MQTT_CLIENT_ID,
    clean: true,
    reconnectPeriod: 3000,
    connectTimeout: 10000,
    resubscribe: true
  });
  mqttClient.on("connect", () => {
    mqttState.connected = true;
    mqttState.last_error = null;
    mqttClient.subscribe(MQTT_TOPIC, { qos: 1 }, (error) => {
      if (error) {
        mqttState.last_error = error.message;
        console.error(`MQTT subscribe failed: ${error.message}`);
      } else {
        console.log(`MQTT connected to ${mqttState.broker}; subscribed to ${MQTT_TOPIC}`);
      }
    });
  });
  mqttClient.on("reconnect", () => { mqttState.connected = false; });
  mqttClient.on("close", () => { mqttState.connected = false; });
  mqttClient.on("offline", () => { mqttState.connected = false; });
  mqttClient.on("error", (error) => {
    mqttState.connected = false;
    mqttState.last_error = error.message;
    console.error(`MQTT error: ${error.message}`);
  });
  mqttClient.on("message", (topic, message) => {
    try {
      const record = acceptMqttTelemetry(topic, message);
      console.log(`MQTT accepted ${record.device_id} sequence=${record.sequence ?? "--"}`);
    } catch (error) {
      mqttState.rejected_count += 1;
      mqttState.last_error = error.message;
      console.error(`MQTT message rejected on ${topic}: ${error.message}`);
    }
  });
}

function contentType(filePath) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const filePath = path.resolve(FRONTEND_DIR, requested);
  const firstSegment = requested.split(/[\\/]/)[0];
  if (!filePath.startsWith(FRONTEND_DIR + path.sep) || firstSegment === "backend" || firstSegment.startsWith(".")) {
    sendJson(res, 403, { error: "禁止访问" }); return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) { sendJson(res, 404, { error: "资源不存在" }); return; }
    res.writeHead(200, { "Content-Type": contentType(filePath), "Content-Length": stats.size, "Cache-Control": "no-cache" });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders()); res.end(); return; }
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: mqttState.enabled && !mqttState.connected ? "degraded" : "ok",
        service: "GYX-1 telemetry",
        time: new Date().toISOString(),
        database: path.basename(DB_PATH),
        mqtt: publicMqttState()
      });
    } else if (req.method === "GET" && url.pathname === "/api/mqtt/status") {
      sendJson(res, 200, publicMqttState());
    } else if (req.method === "GET" && url.pathname === "/api/devices") {
      sendJson(res, 200, statements.listDevices.all().map(deviceView));
    } else if (req.method === "GET" && /^\/api\/devices\/[^/]+\/latest$/.test(url.pathname)) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[3]);
      const row = statements.latest.get(deviceId);
      row ? sendJson(res, 200, row) : sendJson(res, 404, { error: "设备暂无数据" });
    } else if (req.method === "GET" && /^\/api\/devices\/[^/]+\/history$/.test(url.pathname)) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[3]);
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit")) || 300));
      sendJson(res, 200, statements.history.all(deviceId, limit).reverse());
    } else if (req.method === "POST" && url.pathname === "/api/telemetry") {
      const record = insertTelemetry(await readBody(req));
      broadcastTelemetry(record);
      sendJson(res, 202, { accepted: true, data: record });
    } else if (url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "接口不存在" });
    } else if (req.method === "GET") {
      serveStatic(url.pathname, res);
    } else {
      sendJson(res, 405, { error: "请求方法不支持" });
    }
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const key = req.headers["sec-websocket-key"];
  const deviceId = url.searchParams.get("device_id");
  if (url.pathname !== "/api/realtime" || !key || !deviceId) { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""
  ].join("\r\n"));
  const client = { socket, deviceId };
  websocketClients.add(client);
  socket.write(websocketFrame({ type: "connected", device_id: deviceId, time: new Date().toISOString() }));
  socket.on("close", () => websocketClients.delete(client));
  socket.on("error", () => websocketClients.delete(client));
  socket.on("data", (buffer) => {
    if ((buffer[0] & 0x0f) === 0x08) { websocketClients.delete(client); socket.end(); }
  });
});

const heartbeatTimer = setInterval(() => {
  const frame = websocketFrame({ type: "heartbeat", time: new Date().toISOString() });
  for (const client of websocketClients) {
    if (!client.socket.destroyed) client.socket.write(frame);
  }
}, 15000);
heartbeatTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`GYX-1 server listening on http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  startMqtt();
});

function shutdown() {
  clearInterval(heartbeatTimer);
  if (mqttClient) mqttClient.end(true);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

