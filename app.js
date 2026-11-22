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
  simulatedSeconds: 0,
  aboveWarningSeconds: 0,
  aboveAlarmSeconds: 0
};

const $ = (id) => document.getElementById(id);

const elements = {
  sampleForm: $("sampleForm"),
  configForm: $("configForm"),
  validationMessage: $("validationMessage"),
  simulationControl: $("simulationControl"),
  simulationLevel: $("simulationLevel"),
  simulationOutput: $("simulationOutput"),
  sampleBtn: $("sampleBtn"),
  simulationBtn: $("simulationBtn"),
  csvInput: $("csvInput"),
  canvas: $("trendChart")
};

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}不是有效数字`);
  return number;
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
  const interval = Math.max(0.1, finiteNumber(input.interval, "采样间隔"));

  if (vout <= 0 || vout >= config.vc) throw new Error(`Vout必须在0和Vc (${config.vc} V)之间`);
  if (humidity < 0 || humidity > 100) throw new Error("湿度必须在0～100 %RH之间");
  if (heaterVoltage < 0 || heaterCurrent < 0) throw new Error("加热器电压和电流不能为负数");

  const rs = config.topology === "sensorTop"
    ? config.rl * (config.vc / vout - 1)
    : config.rl * vout / (config.vc - vout);
  const rawRatio = rs / config.r0;

  // Linear compensation is a demonstrator. Replace with the sensor vendor's lookup table for production.
  const compensationFactor = Math.max(0.05,
    1 + config.tempCoefficient * (temperature - 25) + config.humidityCoefficient * (humidity - 50));
  const correctedRatio = rawRatio * compensationFactor;
  const concentration = Math.max(0, Math.pow(config.coefficientA / correctedRatio, 1 / config.coefficientB));
  const lel = concentration / config.lelPpm * 100;
  const response = (config.r0 - rs) / config.r0 * 100;
  const heaterPower = heaterVoltage * heaterCurrent;
  const heaterResistance = heaterCurrent > 0 ? heaterVoltage / (heaterCurrent / 1000) : Infinity;
  const prior = state.records.at(-1);
  const riseRate = prior ? (concentration - prior.concentration) / interval : 0;

  let status = "normal";
  let statusLabel = "正常";
  let reason = "浓度低于预警阈值";
  const signalFault = !Number.isFinite(rs) || rs <= 0;
  const heaterFault = heaterPower < config.heaterMinPower || heaterPower > config.heaterMaxPower;

  if (signalFault || heaterFault) {
    status = "fault";
    statusLabel = "传感器故障";
    reason = signalFault ? "敏感电阻计算异常" : `加热功率 ${heaterPower.toFixed(1)} mW 超出允许范围`;
    state.aboveWarningSeconds = 0;
    state.aboveAlarmSeconds = 0;
  } else {
    state.aboveWarningSeconds = concentration >= config.warningPpm ? state.aboveWarningSeconds + interval : 0;
    state.aboveAlarmSeconds = concentration >= config.alarmPpm ? state.aboveAlarmSeconds + interval : 0;

    if (concentration >= config.alarmPpm && state.aboveAlarmSeconds >= config.alarmDelay) {
      status = "alarm";
      statusLabel = "泄漏报警";
      reason = `浓度超过报警值并持续 ${state.aboveAlarmSeconds.toFixed(1)} 秒`;
    } else if (concentration >= config.warningPpm && state.aboveWarningSeconds >= config.warningDelay) {
      status = "warning";
      statusLabel = "泄漏预警";
      reason = `浓度超过预警值并持续 ${state.aboveWarningSeconds.toFixed(1)} 秒`;
    } else if (concentration >= config.alarmPpm) {
      status = "warning";
      statusLabel = "等待确认";
      reason = `已超过报警值，等待达到 ${config.alarmDelay} 秒确认延时`;
    } else if (concentration >= config.warningPpm) {
      status = "warning";
      statusLabel = "浓度升高";
      reason = `已超过预警值，等待达到 ${config.warningDelay} 秒确认延时`;
    }
  }

  return {
    timestamp,
    vout,
    temperature,
    humidity,
    heaterVoltage,
    heaterCurrent,
    interval,
    rs,
    rawRatio,
    correctedRatio,
    concentration,
    lel,
    response,
    heaterPower,
    heaterResistance,
    riseRate,
    status,
    statusLabel,
    reason
  };
}

function readSampleForm() {
  return {
    vout: $("vout").value,
    temperature: $("temperature").value,
    humidity: $("humidity").value,
    heaterVoltage: $("heaterVoltage").value,
    heaterCurrent: $("heaterCurrent").value,
    interval: $("sampleInterval").value
  };
}

function addSample(input, timestamp) {
  clearMessage();
  const record = calculateSample(input, timestamp);
  state.records.push(record);
  if (state.records.length > 500) state.records.shift();
  render(record);
}

function formatNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function render(record) {
  if (record) {
    $("systemStatusTitle").textContent = record.statusLabel;
    $("statusReason").textContent = record.reason;
    $("statusDot").className = `status-dot ${record.status}`;
    $("ppmValue").textContent = formatNumber(record.concentration, record.concentration < 100 ? 1 : 0);
    $("lelValue").textContent = formatNumber(record.lel, 2);
    $("responseValue").textContent = formatNumber(record.response, 1);
    $("calcRs").textContent = `${formatNumber(record.rs, 3)} kΩ`;
    $("calcRatio").textContent = formatNumber(record.rawRatio, 4);
    $("calcCorrected").textContent = formatNumber(record.correctedRatio, 4);
    $("calcPower").textContent = `${formatNumber(record.heaterPower, 1)} mW`;
    $("calcRiseRate").textContent = `${formatNumber(record.riseRate, 1)} ppm/s`;
  }
  renderRecords();
  drawChart();
}

function renderRecords() {
  const body = $("recordsBody");
  $("recordCount").textContent = `${state.records.length} 条`;
  if (!state.records.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="7">录入数据后将在这里显示结果</td></tr>';
    return;
  }
  body.innerHTML = state.records.slice(-12).reverse().map((item) => `
    <tr>
      <td>${item.timestamp.toLocaleTimeString("zh-CN", { hour12: false })}</td>
      <td>${item.vout.toFixed(3)} V</td>
      <td>${formatNumber(item.rs, 2)} kΩ</td>
      <td>${item.temperature.toFixed(1)} °C</td>
      <td>${item.humidity.toFixed(1)} %</td>
      <td>${formatNumber(item.concentration, 0)}</td>
      <td><span class="status-badge ${item.status}">${item.statusLabel}</span></td>
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
  const width = rect.width;
  const height = rect.height;
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
    const value = maximum * i / 4;
    const lineY = y(value);
    ctx.strokeStyle = "#e3e9e9";
    ctx.beginPath(); ctx.moveTo(margin.left, lineY); ctx.lineTo(width - margin.right, lineY); ctx.stroke();
    ctx.fillStyle = "#718085";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(value).toLocaleString("zh-CN"), margin.left - 8, lineY + 4);
  }

  const thresholdLine = (value, color) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(margin.left, y(value)); ctx.lineTo(width - margin.right, y(value)); ctx.stroke();
    ctx.restore();
  };
  thresholdLine(state.config.warningPpm, "#b56a00");
  thresholdLine(state.config.alarmPpm, "#c63f32");

  const gradient = ctx.createLinearGradient(0, margin.top, 0, height - margin.bottom);
  gradient.addColorStop(0, "rgba(8,125,114,0.24)");
  gradient.addColorStop(1, "rgba(8,125,114,0.015)");
  ctx.beginPath();
  data.forEach((item, index) => index ? ctx.lineTo(x(index), y(item.concentration)) : ctx.moveTo(x(index), y(item.concentration)));
  ctx.lineTo(x(data.length - 1), height - margin.bottom);
  ctx.lineTo(x(0), height - margin.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  data.forEach((item, index) => index ? ctx.lineTo(x(index), y(item.concentration)) : ctx.moveTo(x(index), y(item.concentration)));
  ctx.strokeStyle = "#087d72";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  const last = data.at(-1);
  ctx.beginPath(); ctx.arc(x(data.length - 1), y(last.concentration), 4, 0, Math.PI * 2);
  ctx.fillStyle = last.status === "alarm" ? "#c63f32" : "#087d72";
  ctx.fill();
  ctx.fillStyle = "#718085";
  ctx.textAlign = "left";
  ctx.fillText("ppm", 8, 12);
}

function resetRecords() {
  stopSimulation();
  state.records = [];
  state.aboveWarningSeconds = 0;
  state.aboveAlarmSeconds = 0;
  $("systemStatusTitle").textContent = "等待数据";
  $("statusReason").textContent = "录入一组有效数据后开始判断";
  $("statusDot").className = "status-dot normal";
  ["ppmValue", "lelValue", "responseValue"].forEach((id) => $(id).textContent = "--");
  ["calcRs", "calcRatio", "calcCorrected", "calcPower", "calcRiseRate"].forEach((id) => $(id).textContent = "--");
  render();
}

function setConfigForm(config) {
  Object.entries(config).forEach(([key, value]) => {
    const input = $(key);
    if (input) input.value = value;
  });
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  elements.simulationControl.hidden = mode !== "simulate";
  elements.sampleBtn.hidden = mode === "simulate";
  elements.simulationBtn.hidden = mode !== "simulate";
  if (mode !== "simulate") stopSimulation();
}

function simulationTick() {
  const level = Number(elements.simulationLevel.value) / 100;
  const interval = Math.max(0.1, Number($("sampleInterval").value));
  state.simulatedSeconds += interval;
  const targetRatio = Math.max(0.08, 1 - level * 0.92);
  const targetRs = state.config.r0 * targetRatio;
  const vout = state.config.topology === "sensorTop"
    ? state.config.vc * state.config.rl / (targetRs + state.config.rl)
    : state.config.vc * targetRs / (targetRs + state.config.rl);
  const noise = (Math.random() - 0.5) * 0.015;
  $("vout").value = Math.max(0.001, Math.min(state.config.vc - 0.001, vout + noise)).toFixed(3);
  addSample(readSampleForm(), new Date());
}

function startSimulation() {
  if (state.simulationTimer) {
    stopSimulation();
    return;
  }
  const interval = Math.max(0.1, Number($("sampleInterval").value));
  elements.simulationBtn.textContent = "停止模拟";
  simulationTick();
  state.simulationTimer = window.setInterval(simulationTick, interval * 1000);
}

function stopSimulation() {
  if (state.simulationTimer) window.clearInterval(state.simulationTimer);
  state.simulationTimer = null;
  elements.simulationBtn.textContent = "开始模拟";
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
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
  const normalizedHeaders = rows[0].map((value) => value.trim().toLowerCase());
  const aliases = {
    timestamp: ["timestamp", "time", "时间"],
    vout: ["vout", "输出电压"],
    temperature: ["temperature", "temp", "温度"],
    humidity: ["humidity", "rh", "湿度"],
    heaterVoltage: ["heatervoltage", "vh", "加热器电压"],
    heaterCurrent: ["heatercurrent", "ih", "加热器电流"],
    interval: ["interval", "采样间隔"]
  };
  const indexFor = (name) => normalizedHeaders.findIndex((header) => aliases[name].includes(header));
  const indices = Object.fromEntries(Object.keys(aliases).map((name) => [name, indexFor(name)]));
  if (["vout", "temperature", "humidity"].some((key) => indices[key] < 0)) {
    throw new Error("CSV至少需要 vout、temperature、humidity 三列");
  }

  let imported = 0;
  rows.slice(1).forEach((row) => {
    try {
      const value = (name, fallback) => indices[name] >= 0 && row[indices[name]] !== "" ? row[indices[name]] : fallback;
      const timestampValue = value("timestamp", "");
      const timestamp = timestampValue && !Number.isNaN(Date.parse(timestampValue)) ? new Date(timestampValue) : new Date();
      addSample({
        vout: value("vout", ""),
        temperature: value("temperature", 25),
        humidity: value("humidity", 50),
        heaterVoltage: value("heaterVoltage", $("heaterVoltage").value),
        heaterCurrent: value("heaterCurrent", $("heaterCurrent").value),
        interval: value("interval", $("sampleInterval").value)
      }, timestamp);
      imported++;
    } catch (error) {
      // Invalid rows are skipped; a completely invalid file still reports an error below.
    }
  });
  if (!imported) throw new Error("CSV中没有有效数据，请检查电压范围和列内容");
}

function escapeCsv(value) {
  const string = String(value ?? "");
  return /[",\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function exportCsv() {
  if (!state.records.length) { showMessage("当前没有可导出的采样记录"); return; }
  const header = ["timestamp", "vout", "temperature", "humidity", "heaterVoltage", "heaterCurrent", "rsKohm", "ratio", "correctedRatio", "h2Ppm", "lelPercent", "status"];
  const lines = state.records.map((item) => [
    item.timestamp.toISOString(), item.vout, item.temperature, item.humidity,
    item.heaterVoltage, item.heaterCurrent, item.rs, item.rawRatio,
    item.correctedRatio, item.concentration, item.lel, item.statusLabel
  ].map(escapeCsv).join(","));
  const blob = new Blob(["\ufeff" + [header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `qingqi-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

elements.sampleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try { addSample(readSampleForm()); } catch (error) { showMessage(error.message); }
});

elements.configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const config = readConfig();
    validateConfig(config);
    state.config = config;
    clearMessage();
    resetRecords();
    showMessage("参数已应用。为避免混用不同模型，原采样记录已清空。", "success");
  } catch (error) { showMessage(error.message); }
});

document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
elements.simulationLevel.addEventListener("input", () => elements.simulationOutput.textContent = `${elements.simulationLevel.value}%`);
elements.simulationBtn.addEventListener("click", () => {
  try { clearMessage(); startSimulation(); } catch (error) { showMessage(error.message); }
});
$("resetBtn").addEventListener("click", resetRecords);
$("restoreDefaultsBtn").addEventListener("click", () => { setConfigForm(DEFAULT_CONFIG); });
$("exportBtn").addEventListener("click", exportCsv);
elements.csvInput.addEventListener("change", async () => {
  const file = elements.csvInput.files[0];
  if (!file) return;
  try { clearMessage(); importCsv(await file.text()); }
  catch (error) { showMessage(error.message); }
  finally { elements.csvInput.value = ""; }
});

window.addEventListener("resize", drawChart);
window.setInterval(() => {
  $("clock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
}, 1000);

setConfigForm(DEFAULT_CONFIG);
$("clock").textContent = new Date().toLocaleString("zh-CN", { hour12: false });
drawChart();

