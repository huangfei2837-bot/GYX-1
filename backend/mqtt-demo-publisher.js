"use strict";

const mqtt = require("mqtt");

const broker = process.env.GYX1_MQTT_URL || "mqtt://192.168.1.112:1883";
const deviceId = process.env.GYX1_DEVICE_ID || "GYX-1-001";
const topic = `gyx1/${deviceId}/telemetry`;
const sequence = Number(process.env.GYX1_SEQUENCE || Math.floor(Date.now() / 1000));

if (!process.env.GYX1_MQTT_USERNAME || !process.env.GYX1_MQTT_PASSWORD) {
  console.error("缺少GYX1_MQTT_USERNAME或GYX1_MQTT_PASSWORD");
  process.exit(1);
}

const payload = {
  device_id: deviceId,
  sequence,
  timestamp: new Date().toISOString(),
  adc_raw: 2048,
  vout: 2.501,
  vc: 5,
  vref: 3.3,
  heater_voltage: 1.8,
  heater_current: 32.1,
  temperature: 25.4,
  humidity: 51.2,
  heater_stage: "mqtt_test",
  warmup_complete: true,
  fault_code: 0,
  firmware_version: "mqtt-test-1.0.0",
  interval: 1
};

const client = mqtt.connect(broker, {
  username: process.env.GYX1_MQTT_USERNAME,
  password: process.env.GYX1_MQTT_PASSWORD,
  clientId: `gyx1-test-${process.pid}-${Date.now()}`,
  clean: true,
  reconnectPeriod: 0,
  connectTimeout: 10000
});

const timer = setTimeout(() => {
  console.error("MQTT测试发布超时");
  client.end(true);
  process.exit(1);
}, 15000);

client.on("connect", () => {
  client.publish(topic, JSON.stringify(payload), { qos: 1, retain: false }, (error) => {
    clearTimeout(timer);
    if (error) {
      console.error(`MQTT测试发布失败：${error.message}`);
      client.end(true);
      process.exitCode = 1;
      return;
    }
    console.log(`MQTT测试数据已发布：${deviceId} sequence=${sequence}`);
    client.end(false);
  });
});

client.on("error", (error) => {
  clearTimeout(timer);
  console.error(`MQTT连接失败：${error.message}`);
  client.end(true);
  process.exitCode = 1;
});
