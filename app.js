"use strict";

const DEFAULT_CONFIG = Object.freeze({
  topology: "sensorTop",
  vc: 5,
  rl: 10,
  r0: 10,
  lelPpm: 40000,
  coefficientA: 10,
  coefficientB: 0.5,
  tempCoefficient: 0.002,
  humidityCoefficient: 0.001,
  warningPpm: 4000,
  alarmPpm: 10000,
  warningDelay: 5,
  alarmDelay: 2,
  heaterMinPower: 40,
  heaterMaxPower: 80
});

const state = {
  config: { ...DEFAULT_CONFIG },
  records: [],
  mode: "manual",
  simulationTimer: null,
  sequence: 0,
  packetLoss: 0,
  aboveWarningSeconds: 0,
  aboveAlarmSeconds: 0,
  apiBaseUrl: localStorage.getItem("gyx1.apiBaseUrl") || "http://127.0.0.1:8080",
  activeDeviceId: localStorage.getItem("gyx1.deviceId") || "",
  socket: null,
  shouldReconnect: false,
  reconnectTimer: null
};

const $ = (id) => document.getElementById(id);
const elements = {
  sampleForm: $("sampleForm"),
  configForm: $("configForm"),
  connectionForm: $("connectionForm"),
  validationMessage: $("validationMessage"),
  simulationControl: $("simulationControl"),
  simulationLevel: $("simulationLevel"),
  simulationOutput: $("simulationOutput"),
  sampleBtn: $("sampleBtn"),
  simulationBtn: $("simulationBtn"),
  realtimeControl: $("realtimeControl"),
  realtimeConnectBtn: $("realtimeConnectBtn"),
  csvInput: $("csvInput"),
  canvas: $("trendChart")
};

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}不是有效数字`);
  return number;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function readConfig() {
  return {
    topology: $("topology").value,
    vc: finiteNumber($("vc").value, "分压电压"),
    rl: finiteNumber($("rl").value, "负载电阻"),
    r0: finiteNumber($("r0").value, "R0"),
    lelPpm: finiteNumber($("lelPpm").value, "LEL浓度"),
    coefficientA: finiteNumber($("coefficientA").value, "系数A"),
    coefficientB: finiteNumber($("coefficientB").value, "系数B"),
    tempCoefficient: finiteNumber($("tempCoefficient").value, "温度系数"),
    humidityCoefficient: finiteNumber($("humidityCoefficient").value, "湿度系数"),
    warningPpm: finiteNumber($("warningPpm").value, "预警阈值"),
    alarmPpm: finiteNumber($("alarmPpm").value, "报警阈值"),
    warningDelay: finiteNumber($("warningDelay").value, "预警延时"),
    alarmDelay: finiteNumber($("alarmDelay").value, "报警延时"),
    heaterMinPower: finiteNumber($("heaterMinPower").value, "加热器最小功率"),
    heaterMaxPower: finiteNumber($("heaterMaxPower").value, "加热器最大功率")
  };
}

function validateConfig(config) {
  const positive = ["vc", "rl", "r0", "lelPpm", "coefficientA", "coefficientB"];
  if (positive.some((key) => config[key] <= 0)) throw new Error("电路和标定参数必须大于0");
  if (config.warningPpm < 0 || config.alarmPpm <= config.warningPpm) throw new Error("报警阈值必须高于预警阈值");
  if (config.warningDelay < 0 || config.alarmDelay < 0) throw new Error("延时不能为负数");
  if (config.heaterMaxPower <= config.heaterMinPower) throw new Error("加热器最大功率必须高于最小功率");
}

function showMessage(message, type = "error") {
  elements.validationMessage.textContent = message;
  elements.validationMessage.classList.toggle("success", type === "success");
  elements.validationMessage.hidden = false;
}

function clearMessage() {
  elements.validationMessage.hidden = true;
  elements.validationMessage.textContent = "";
  elements.validationMessage.classList.remove("success");
}

function calculateSample(input, timestamp = new Date()) {
  const config = state.config;
  const vout = finiteNumber(input.vout, "输出电压");
  const temperature = finiteNumber(input.temperature, "温度");
  const humidity = finiteNumber(input.humidity, "湿度");
  const heaterVoltage = finiteNumber(input.heaterVoltage, "加热器电压");
  const heaterCurrent = finiteNumber(input.heaterCurrent, "加热器电流");
  const interval = Math.max(0.1, finiteNumber(input.interval ?? 1, "采样间隔"));
  const faultCode = Math.max(0, Math.trunc(optionalNumber(input.faultCode) ?? 0));

  if (vout <= 0 || vout >= config.vc) throw new Error(`Vout必须在0和Vc (${config.vc} V)之间`);
  if (humidity < 0 || humidity > 100) throw new Error("湿度必须在0～100 %RH之间");
  if (heaterVoltage < 0 || heaterCurrent < 0) throw new Error("加热器电压和电流不能为负数");

  const rs = config.topology === "sensorTop"
    ? config.rl * (config.vc / vout - 1)
    : config.rl * vout / (config.vc - vout);
  const rawRatio = rs / config.r0;
  const compensationFactor = Math.max(0.05,
    1 + config.tempCoefficient * (temperature - 25) + config.humidityCoefficient * (humidity - 50));
  const correctedRatio = rawRatio * compensationFactor;
  const localConcentration = Math.max(0, Math.pow(config.coefficientA / correctedRatio, 1 / config.coefficientB));
  const edgePpm = optionalNumber(input.computedPpm);
  const concentration = edgePpm === null ? localConcentration : Math.max(0, edgePpm);
  const lel = concentration / config.lelPpm * 100;
  const response = (config.r0 - rs) / config.r0 * 100;
  const heaterPower = heaterVoltage * heaterCurrent;
  const heaterResistance = heaterCurrent > 0 ? heaterVoltage / (heaterCurrent / 1000) : Infinity;
  const prior = state.records.at(-1);
  const riseRate = prior ? (concentration - prior.concentration) / interval : 0;
  const signalFault = !Number.isFinite(rs) || rs <= 0;
  const heaterFault = heaterPower < config.heaterMinPower || heaterPower > config.heaterMaxPower;

  let status = "normal";
  let statusLabel = "正常";
  let reason = "浓度低于预警阈值";
  if (faultCode || signalFault || heaterFault) {
    status = "fault";
    statusLabel = "传感器故障";
    reason = faultCode ? `设备报告故障代码 ${faultCode}` : signalFault ? "敏感电阻计算异常" : `加热功率 ${heaterPower.toFixed(1)} mW 超出允许范围`;
    state.aboveWarningSeconds = 0;
    state.aboveAlarmSeconds = 0;
  } else {
    state.aboveWarningSeconds = concentration >= config.warningPpm ? state.aboveWarningSeconds + interval : 0;
    state.aboveAlarmSeconds = concentration >= config.alarmPpm ? state.aboveAlarmSeconds + interval : 0;
    if (concentration >= config.alarmPpm && state.aboveAlarmSeconds >= config.alarmDelay) {
      status = "alarm"; statusLabel = "泄漏报警";
      reason = `浓度超过报警值并持续 ${state.aboveAlarmSeconds.toFixed(1)} 秒`;
    } else if (concentration >= config.warningPpm && state.aboveWarningSeconds >= config.warningDelay) {
      status = "warning"; statusLabel = "泄漏预警";
      reason = `浓度超过预警值并持续 ${state.aboveWarningSeconds.toFixed(1)} 秒`;
    } else if (concentration >= config.alarmPpm) {
      status = "warning"; statusLabel = "等待确认";
      reason = `已超过报警值，等待达到 ${config.alarmDelay} 秒确认延时`;
    } else if (concentration >= config.warningPpm) {
      status = "warning"; statusLabel = "浓度升高";
      reason = `已超过预警值，等待达到 ${config.warningDelay} 秒确认延时`;
    }
  }

  return {
    timestamp,
    deviceId: input.deviceId || "GYX-1-DEMO",
    sequence: optionalNumber(input.sequence),
    adcRaw: optionalNumber(input.adcRaw),
    vout,
    temperature,
    humidity,
    heaterVoltage,
    heaterCurrent,
    interval,
    faultCode,
    firmwareVersion: input.firmwareVersion || "--",
    rs,
    rawRatio,
    correctedRatio,
    concentration,
    localConcentration,
    lel,
    response,
    heaterPower,
    heaterResistance,
    riseRate,
    aiProbability: optionalNumber(input.aiProbability),
    modelVersion: input.modelVersion || null,
    source: input.source || "manual",
    status,
    statusLabel,
    reason
  };
}

function readSampleForm() {
  return {
    deviceId: state.mode === "simulate" ? "GYX-1-DEMO" : "GYX-1-MANUAL",
    sequence: ++state.sequence,
    adcRaw: $("adcRaw").value,
    vout: $("vout").value,
    temperature: $("temperature").value,
    humidity: $("humidity").value,
    heaterVoltage: $("heaterVoltage").value,
    heaterCurrent: $("heaterCurrent").value,
    interval: $("sampleInterval").value,
    faultCode: $("faultCode").value,
    firmwareVersion: $("firmwareVersion").value,
    source: state.mode
  };
}

function addSample(input, timestamp, renderNow = true) {
  const record = calculateSample(input, timestamp || new Date());
  const previous = state.records.at(-1);
  if (previous && record.sequence !== null && previous.sequence !== null && record.sequence > previous.sequence + 1) {
    state.packetLoss += record.sequence - previous.sequence - 1;
  }
  if (input.lostCount !== undefined && optionalNumber(input.lostCount) !== null) state.packetLoss = Number(input.lostCount);
  state.records.push(record);
  if (state.records.length > 500) state.records.shift();
  if (renderNow) render(record);
  return record;
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "--";
  return value.toLocaleTimeString("zh-CN", { hour12: false });
}

function sourceLabel(source) {
  return ({ manual: "手动输入", simulate: "模拟数据", realtime: "实时设备", import: "CSV导入" })[source] || source;
}

function render(record) {
  if (record) {
    $("systemStatusTitle").textContent = record.statusLabel;
    $("statusReason").textContent = record.reason;
    $("statusDot").className = `status-dot ${record.status}`;
    $("ppmValue").textContent = formatNumber(record.concentration, record.concentration < 100 ? 1 : 0);
    $("lelValue").textContent = formatNumber(record.lel, 2);
    $("aiProbabilityValue").textContent = record.aiProbability === null ? "--" : formatNumber(record.aiProbability * 100, 1);
    $("aiSourceValue").textContent = record.aiProbability === null ? "未接入AI模型" : record.modelVersion ? `模型 ${record.modelVersion}` : "演示估算";

    $("rawAdcValue").textContent = record.adcRaw === null ? "--" : Math.round(record.adcRaw).toLocaleString("zh-CN");
    $("voutMetric").textContent = formatNumber(record.vout, 3);
    $("rsMetric").textContent = formatNumber(record.rs, 2);
    $("ratioMetric").textContent = formatNumber(record.rawRatio, 4);
    $("heaterVoltageMetric").textContent = formatNumber(record.heaterVoltage, 2);
    $("heaterCurrentMetric").textContent = formatNumber(record.heaterCurrent, 1);
    $("heaterPowerMetric").textContent = formatNumber(record.heaterPower, 1);
    $("temperatureMetric").textContent = formatNumber(record.temperature, 1);
    $("humidityMetric").textContent = formatNumber(record.humidity, 1);
    $("riseRateMetric").textContent = formatNumber(record.riseRate, 1);

    $("activeDeviceName").textContent = record.deviceId;
    $("lastSeenValue").textContent = formatTime(record.timestamp);
    $("sequenceValue").textContent = record.sequence === null ? "--" : Math.round(record.sequence).toLocaleString("zh-CN");
    $("packetLossValue").textContent = state.packetLoss.toLocaleString("zh-CN");
    $("firmwareValue").textContent = record.firmwareVersion;
    $("faultCodeValue").textContent = String(record.faultCode);
    if (record.source !== "realtime") {
      $("deviceOnlineText").textContent = record.source === "simulate" ? "演示模式" : "本地数据";
      $("deviceOnlineDot").className = "device-dot demo";
    }

    $("calcRs").textContent = `${formatNumber(record.rs, 3)} kΩ`;
    $("calcRatio").textContent = formatNumber(record.rawRatio, 4);
    $("calcCorrected").textContent = formatNumber(record.correctedRatio, 4);
    $("calcPower").textContent = `${formatNumber(record.heaterPower, 1)} mW`;
    $("calcRiseRate").textContent = `${formatNumber(record.riseRate, 1)} ppm/s`;
    $("calcSource").textContent = sourceLabel(record.source);
  }
  renderRecords();
  drawChart();
}

function renderRecords() {
  const body = $("recordsBody");
  $("recordCount").textContent = `${state.records.length} 条`;
  if (!state.records.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="9">录入数据后将在这里显示结果</td></tr>';
    return;
  }
  body.innerHTML = state.records.slice(-14).reverse().map((item) => `
    <tr>
      <td>${escapeHtml(formatTime(item.timestamp))}</td>
      <td>${item.sequence === null ? "--" : escapeHtml(Math.round(item.sequence))}</td>
      <td>${item.adcRaw === null ? "--" : escapeHtml(Math.round(item.adcRaw))}</td>
      <td>${item.vout.toFixed(3)} V</td>
      <td>${formatNumber(item.rs, 2)} kΩ</td>
      <td>${item.temperature.toFixed(1)} °C</td>
      <td>${item.humidity.toFixed(1)} %</td>
      <td>${formatNumber(item.concentration, 0)}</td>
      <td><span class="status-badge ${item.status}">${escapeHtml(item.statusLabel)}</span></td>
    </tr>`).join("");
}

function drawChart() {
  const canvas = elements.canvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height;
  const data = state.records.slice(-60);
  $("chartEmpty").hidden = data.length > 0;
  if (!data.length || width < 40 || height < 40) return;
  const margin = { top: 14, right: 18, bottom: 28, left: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maximum = Math.max(state.config.alarmPpm * 1.2, ...data.map((d) => d.concentration), 100);
  const y = (value) => margin.top + plotH - Math.min(value / maximum, 1) * plotH;
  const x = (index) => margin.left + (data.length === 1 ? plotW / 2 : index / (data.length - 1) * plotW);
  ctx.font = '11px "Microsoft YaHei", sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const value = maximum * i / 4, lineY = y(value);
    ctx.strokeStyle = "#e3e9e9";
    ctx.beginPath(); ctx.moveTo(margin.left, lineY); ctx.lineTo(width - margin.right, lineY); ctx.stroke();
    ctx.fillStyle = "#718085"; ctx.textAlign = "right";
    ctx.fillText(Math.round(value).toLocaleString("zh-CN"), margin.left - 8, lineY + 4);
  }
  const thresholdLine = (value, color) => {
    ctx.save(); ctx.strokeStyle = color; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(margin.left, y(value)); ctx.lineTo(width - margin.right, y(value)); ctx.stroke(); ctx.restore();
  };
  thresholdLine(state.config.warningPpm, "#b56a00"); thresholdLine(state.config.alarmPpm, "#c63f32");
  const gradient = ctx.createLinearGradient(0, margin.top, 0, height - margin.bottom);
  gradient.addColorStop(0, "rgba(8,125,114,0.24)"); gradient.addColorStop(1, "rgba(8,125,114,0.015)");
  ctx.beginPath(); data.forEach((item, index) => index ? ctx.lineTo(x(index), y(item.concentration)) : ctx.moveTo(x(index), y(item.concentration)));
  ctx.lineTo(x(data.length - 1), height - margin.bottom); ctx.lineTo(x(0), height - margin.bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
  ctx.beginPath(); data.forEach((item, index) => index ? ctx.lineTo(x(index), y(item.concentration)) : ctx.moveTo(x(index), y(item.concentration)));
  ctx.strokeStyle = "#087d72"; ctx.lineWidth = 2.5; ctx.lineJoin = "round"; ctx.stroke();
  const last = data.at(-1);
  ctx.beginPath(); ctx.arc(x(data.length - 1), y(last.concentration), 4, 0, Math.PI * 2); ctx.fillStyle = last.status === "alarm" ? "#c63f32" : "#087d72"; ctx.fill();
  ctx.fillStyle = "#718085"; ctx.textAlign = "left"; ctx.fillText("ppm", 8, 12);
}

function resetRecords() {
  stopSimulation();
  state.records = [];
  state.packetLoss = 0;
  state.aboveWarningSeconds = 0;
  state.aboveAlarmSeconds = 0;
  $("systemStatusTitle").textContent = "等待数据";
  $("statusReason").textContent = "连接设备、导入数据或启动模拟后开始判断";
  $("statusDot").className = "status-dot normal";
  ["ppmValue", "lelValue", "aiProbabilityValue", "rawAdcValue", "voutMetric", "rsMetric", "ratioMetric", "heaterVoltageMetric", "heaterCurrentMetric", "heaterPowerMetric", "temperatureMetric", "humidityMetric", "riseRateMetric"].forEach((id) => $(id).textContent = "--");
  ["calcRs", "calcRatio", "calcCorrected", "calcPower", "calcRiseRate", "calcSource"].forEach((id) => $(id).textContent = "--");
  $("aiSourceValue").textContent = "等待边缘模型";
  $("packetLossValue").textContent = "0";
  render();
}

function setConfigForm(config) {
  Object.entries(config).forEach(([key, value]) => { const input = $(key); if (input) input.value = value; });
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  elements.simulationControl.hidden = mode !== "simulate";
  elements.sampleBtn.hidden = mode === "simulate";
  elements.simulationBtn.hidden = mode !== "simulate";
  elements.sampleForm.hidden = mode === "realtime";
  elements.realtimeControl.hidden = mode !== "realtime";
  if (mode !== "simulate") stopSimulation();
  if (mode !== "realtime") disconnectRealtime(false);
}

function simulationTick() {
  const level = Number(elements.simulationLevel.value) / 100;
  const interval = Math.max(0.1, Number($("sampleInterval").value));
  const targetRatio = Math.max(0.08, 1 - level * 0.92);
  const targetRs = state.config.r0 * targetRatio;
  const vout = state.config.topology === "sensorTop"
    ? state.config.vc * state.config.rl / (targetRs + state.config.rl)
    : state.config.vc * targetRs / (targetRs + state.config.rl);
  const noise = (Math.random() - 0.5) * 0.015;
  $("vout").value = clamp(vout + noise, 0.001, state.config.vc - 0.001).toFixed(3);
  $("adcRaw").value = Math.round(Number($("vout").value) / state.config.vc * 4095);
  const input = readSampleForm();
  input.aiProbability = clamp((level - 0.18) / 0.65, 0, 1);
  input.modelVersion = "demo-only";
  addSample(input, new Date());
}

function startSimulation() {
  if (state.simulationTimer) { stopSimulation(); return; }
  const interval = Math.max(0.1, Number($("sampleInterval").value));
  clearMessage();
  elements.simulationBtn.textContent = "停止模拟";
  simulationTick();
  state.simulationTimer = window.setInterval(simulationTick, interval * 1000);
}

function stopSimulation() {
  if (state.simulationTimer) window.clearInterval(state.simulationTimer);
  state.simulationTimer = null;
  elements.simulationBtn.textContent = "开始模拟";
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    return await response.json();
  } finally { window.clearTimeout(timer); }
}

function setConnectionState(kind, text) {
  $("connectionBadge").className = `connection-badge ${kind}`;
  $("connectionBadge").querySelector("span").textContent = text;
  $("deviceOnlineDot").className = `device-dot ${kind}`;
  $("deviceOnlineText").textContent = text;
}

async function detectServer() {
  const base = normalizeBaseUrl($("apiBaseUrl").value);
  if (!base) throw new Error("请输入API服务器地址");
  $("apiStatus").textContent = "检测中";
  $("apiStatus").className = "small-status checking";
  const health = await fetchJson(`${base}/health`);
  const devices = await fetchJson(`${base}/api/devices`);
  const select = $("deviceSelect");
  select.innerHTML = devices.length
    ? devices.map((device) => `<option value="${escapeHtml(device.device_id)}">${escapeHtml(device.device_id)} · ${device.online ? "在线" : "离线"}</option>`).join("")
    : '<option value="">暂无设备，请先发送数据</option>';
  const savedDevice = state.activeDeviceId;
  if (savedDevice && devices.some((item) => item.device_id === savedDevice)) select.value = savedDevice;
  $("apiStatus").textContent = `正常 · ${devices.length}台`;
  $("apiStatus").className = "small-status online";
  return { base, health, devices };
}

function mapTelemetry(item) {
  return {
    deviceId: item.device_id,
    sequence: item.sequence,
    adcRaw: item.adc_raw,
    vout: item.vout,
    temperature: item.temperature,
    humidity: item.humidity,
    heaterVoltage: item.heater_voltage,
    heaterCurrent: item.heater_current,
    interval: item.interval ?? 1,
    faultCode: item.fault_code,
    firmwareVersion: item.firmware_version,
    computedPpm: item.computed_ppm,
    aiProbability: item.ai_probability,
    modelVersion: item.model_version,
    lostCount: item.lost_count,
    source: "realtime"
  };
}

async function connectRealtime() {
  state.shouldReconnect = false;
  disconnectRealtime(false);
  const { base } = await detectServer();
  const deviceId = $("deviceSelect").value;
  if (!deviceId) throw new Error("服务器中还没有设备数据");
  state.apiBaseUrl = base;
  state.activeDeviceId = deviceId;
  localStorage.setItem("gyx1.apiBaseUrl", base);
  localStorage.setItem("gyx1.deviceId", deviceId);
  resetRecords();
  state.shouldReconnect = true;

  const history = await fetchJson(`${base}/api/devices/${encodeURIComponent(deviceId)}/history?limit=300`);
  history.forEach((item) => addSample(mapTelemetry(item), new Date(item.timestamp), false));
  if (state.records.length) render(state.records.at(-1));
  $("activeDeviceName").textContent = deviceId;
  $("realtimeTitle").textContent = `正在接收 ${deviceId}`;
  $("realtimeDescription").textContent = `历史数据已加载 ${history.length} 条，等待实时数据。`;

  const wsUrl = new URL(base);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/api/realtime";
  wsUrl.search = new URLSearchParams({ device_id: deviceId }).toString();
  const socket = new WebSocket(wsUrl);
  state.socket = socket;
  setConnectionState("checking", "连接中");

  socket.addEventListener("open", () => {
    setConnectionState("online", "实时在线");
    $("realtimeConnectBtn").textContent = "断开连接";
    clearMessage();
  });
  socket.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === "telemetry" && payload.data) addSample(mapTelemetry(payload.data), new Date(payload.data.timestamp));
    } catch (error) { showMessage(`实时数据解析失败：${error.message}`); }
  });
  socket.addEventListener("close", () => {
    if (state.socket === socket) state.socket = null;
    setConnectionState("offline", "连接断开");
    $("realtimeConnectBtn").textContent = "重新连接";
    if (state.shouldReconnect && state.mode === "realtime") {
      window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = window.setTimeout(() => connectRealtime().catch(() => {}), 3000);
    }
  });
  socket.addEventListener("error", () => showMessage("实时连接失败，请检查服务器地址、HTTPS和防火墙设置"));
}

function disconnectRealtime(userInitiated = true) {
  if (userInitiated) state.shouldReconnect = false;
  window.clearTimeout(state.reconnectTimer);
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.close();
  }
  if (userInitiated) {
    setConnectionState("offline", "未连接");
    $("realtimeConnectBtn").textContent = "连接实时数据";
  }
}

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field.trim()); field = ""; }
    else if (char === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ""; }
    else if (char !== '\r') field += char;
  }
  if (field.length || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((item) => item.some(Boolean));
}

function importCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("CSV没有可导入的数据行");
  const headers = rows[0].map((value) => value.trim().toLowerCase());
  const aliases = {
    timestamp: ["timestamp", "time", "时间"], deviceId: ["device_id", "deviceid", "设备编号"], sequence: ["sequence", "seq", "序号"],
    adcRaw: ["adc_raw", "adcraw", "adc"], vout: ["vout", "输出电压"], temperature: ["temperature", "temp", "温度"], humidity: ["humidity", "rh", "湿度"],
    heaterVoltage: ["heater_voltage", "heatervoltage", "vh", "加热器电压"], heaterCurrent: ["heater_current", "heatercurrent", "ih", "加热器电流"],
    interval: ["interval", "采样间隔"], faultCode: ["fault_code", "faultcode", "故障代码"], firmwareVersion: ["firmware_version", "firmwareversion", "固件版本"],
    computedPpm: ["computed_ppm", "h2ppm", "h2_ppm"], aiProbability: ["ai_probability", "aiprobability"]
  };
  const indices = Object.fromEntries(Object.entries(aliases).map(([name, list]) => [name, headers.findIndex((header) => list.includes(header))]));
  if (["vout", "temperature", "humidity"].some((key) => indices[key] < 0)) throw new Error("CSV至少需要 vout、temperature、humidity 三列");
  let imported = 0;
  rows.slice(1).forEach((row) => {
    try {
      const value = (name, fallback) => indices[name] >= 0 && row[indices[name]] !== "" ? row[indices[name]] : fallback;
      const timestampValue = value("timestamp", "");
      addSample({
        deviceId: value("deviceId", "CSV-IMPORT"), sequence: value("sequence", imported + 1), adcRaw: value("adcRaw", null), vout: value("vout", ""),
        temperature: value("temperature", 25), humidity: value("humidity", 50), heaterVoltage: value("heaterVoltage", $("heaterVoltage").value),
        heaterCurrent: value("heaterCurrent", $("heaterCurrent").value), interval: value("interval", 1), faultCode: value("faultCode", 0),
        firmwareVersion: value("firmwareVersion", "--"), computedPpm: value("computedPpm", null), aiProbability: value("aiProbability", null), source: "import"
      }, timestampValue && !Number.isNaN(Date.parse(timestampValue)) ? new Date(timestampValue) : new Date());
      imported++;
    } catch (_) { /* Invalid CSV rows are skipped. */ }
  });
  if (!imported) throw new Error("CSV中没有有效数据，请检查电压范围和列内容");
}

function escapeCsv(value) {
  const string = String(value ?? "");
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function exportCsv() {
  if (!state.records.length) { showMessage("当前没有可导出的采样记录"); return; }
  const header = ["timestamp", "device_id", "sequence", "adc_raw", "vout", "temperature", "humidity", "heater_voltage", "heater_current", "rs_kohm", "ratio", "corrected_ratio", "h2_ppm", "lel_percent", "ai_probability", "fault_code", "status"];
  const lines = state.records.map((item) => [item.timestamp.toISOString(), item.deviceId, item.sequence, item.adcRaw, item.vout, item.temperature, item.humidity, item.heaterVoltage, item.heaterCurrent, item.rs, item.rawRatio, item.correctedRatio, item.concentration, item.lel, item.aiProbability, item.faultCode, item.statusLabel].map(escapeCsv).join(","));
  const blob = new Blob(["\ufeff" + [header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = `GYX-1-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(url);
}

elements.sampleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try { clearMessage(); addSample(readSampleForm()); } catch (error) { showMessage(error.message); }
});
elements.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const config = readConfig(); validateConfig(config); state.config = config;
    localStorage.setItem("gyx1.config", JSON.stringify(config)); resetRecords();
    showMessage("参数已应用。为避免混用不同模型，原采样记录已清空。", "success");
  } catch (error) { showMessage(error.message); }
});
elements.connectionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try { setMode("realtime"); await connectRealtime(); } catch (error) { setConnectionState("offline", "连接失败"); showMessage(`连接失败：${error.message}`); }
});
$("detectServerBtn").addEventListener("click", () => detectServer().then(() => showMessage("服务器连接正常，可以选择设备。", "success")).catch((error) => { $("apiStatus").textContent = "不可用"; $("apiStatus").className = "small-status offline"; showMessage(`检测失败：${error.message}`); }));
elements.realtimeConnectBtn.addEventListener("click", () => {
  if (state.socket) disconnectRealtime(true);
  else connectRealtime().catch((error) => showMessage(`连接失败：${error.message}`));
});
document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
elements.simulationLevel.addEventListener("input", () => elements.simulationOutput.textContent = `${elements.simulationLevel.value}%`);
elements.simulationBtn.addEventListener("click", () => { try { startSimulation(); } catch (error) { showMessage(error.message); } });
$("resetBtn").addEventListener("click", resetRecords);
$("restoreDefaultsBtn").addEventListener("click", () => setConfigForm(DEFAULT_CONFIG));
$("exportBtn").addEventListener("click", exportCsv);
elements.csvInput.addEventListener("change", async () => {
  const file = elements.csvInput.files[0]; if (!file) return;
  try { clearMessage(); importCsv(await file.text()); } catch (error) { showMessage(error.message); } finally { elements.csvInput.value = ""; }
});
window.addEventListener("resize", drawChart);
window.addEventListener("beforeunload", () => disconnectRealtime(true));
window.setInterval(() => { $("clock").textContent = new Date().toLocaleString("zh-CN", { hour12: false }); }, 1000);

try {
  const savedConfig = JSON.parse(localStorage.getItem("gyx1.config") || "null");
  if (savedConfig) { state.config = { ...DEFAULT_CONFIG, ...savedConfig }; validateConfig(state.config); }
} catch (_) { state.config = { ...DEFAULT_CONFIG }; }
setConfigForm(state.config);
$("apiBaseUrl").value = state.apiBaseUrl;
$("clock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
drawChart();
