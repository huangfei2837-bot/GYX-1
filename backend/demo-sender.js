"use strict";

const API_BASE = (process.env.GYX1_API || "http://127.0.0.1:8080").replace(/\/$/, "");
const DEVICE_ID = process.env.GYX1_DEVICE_ID || "GYX-1-001";
let sequence = 0;
let phase = 0;

async function send() {
  phase += 0.07;
  sequence += 1;
  const leakWave = Math.max(0, Math.sin(phase) - 0.35) / 0.65;
  const vout = 2.48 + leakWave * 1.0 + (Math.random() - 0.5) * 0.018;
  const ppm = Math.round(120 + leakWave * 12500);
  const payload = {
    device_id: DEVICE_ID,
    sequence,
    timestamp: new Date().toISOString(),
    adc_raw: Math.round(vout / 5 * 4095),
    vout: Number(vout.toFixed(3)),
    vc: 5,
    vref: 3.3,
    heater_voltage: 1.8,
    heater_current: 32 + (Math.random() - 0.5) * 0.4,
    temperature: 25 + Math.sin(phase / 6) * 1.2,
    humidity: 50 + Math.sin(phase / 8) * 3,
    heater_stage: "stable",
    warmup_complete: true,
    fault_code: 0,
    firmware_version: "edge-1.0.0",
    computed_ppm: ppm,
    ai_probability: Number(Math.min(0.99, Math.max(0.01, ppm / 10000)).toFixed(3)),
    model_version: "demo-edge-0.1",
    interval: 1
  };
  const response = await fetch(`${API_BASE}/api/telemetry`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(await response.text());
  console.log(`${payload.timestamp} ${DEVICE_ID} seq=${sequence} ppm=${ppm}`);
}

send().catch(console.error);
setInterval(() => send().catch(console.error), 1000);

