# GYX-1 氢气传感器边缘计算平台

GYX-1用于MEMS半导体氢气传感器的数据采集、计算、趋势展示和泄漏判断。

公开演示站：<https://huangfei2837-bot.github.io/GYX-1/>

## 本次改造内容

- 新增实时设备模式和服务器连接配置。
- 新增设备在线状态、最后数据时间、序号、丢包、固件和故障代码。
- 新增原始ADC、Vout、Rs、Rs/R0、微热板电压、电流、功率、温湿度和上升速度。
- 新增AI泄漏概率和模型版本位置。没有真实模型时明确显示“未接入AI模型”。
- 新增设备列表、最新数据、历史数据、数据接收和WebSocket实时接口。
- 新增SQLite本地数据存储和演示设备发送程序。
- 后台可订阅MQTT遥测主题，将ESP32数据写入数据库并实时推送到网页。
- 保留手动输入、模拟、CSV、参数配置、计算和导出功能。

## 快速启动

电脑需要安装 Node.js 24 或更新版本。

首次运行先安装依赖：

```powershell
npm install
```

在项目目录执行：

```powershell
node backend/server.js
```

另开一个终端发送演示设备数据：

```powershell
node backend/demo-sender.js
```

使用Google Chrome打开：

```text
http://127.0.0.1:8080
```

在网页中选择“实时设备”，点击“检测服务器”，选择 `GYX-1-001`，再连接实时数据。

## 设备接口

设备或网关向以下地址发送JSON：

```text
POST http://服务器地址:8080/api/telemetry
```

完整数据示例：

```json
{
  "device_id": "GYX-1-001",
  "sequence": 1258,
  "timestamp": "2026-11-23T10:30:20+08:00",
  "adc_raw": 2048,
  "vout": 2.501,
  "vc": 5.002,
  "vref": 3.3,
  "heater_voltage": 1.8,
  "heater_current": 32.1,
  "temperature": 25.4,
  "humidity": 51.2,
  "heater_stage": "stable",
  "warmup_complete": true,
  "fault_code": 0,
  "firmware_version": "1.0.0",
  "computed_ppm": 820,
  "ai_probability": 0.08,
  "model_version": "h2-edge-1.0",
  "interval": 1
}
```

`computed_ppm`、`ai_probability`和`model_version`是可选字段。边缘设备还没有AI模型时不要伪造这些字段。

## API接口

```text
GET  /health
GET  /api/devices
GET  /api/devices/GYX-1-001/latest
GET  /api/devices/GYX-1-001/history?limit=300
POST /api/telemetry
GET  /api/mqtt/status
WS   /api/realtime?device_id=GYX-1-001
```

详细服务器说明见 `backend/README.md`。

## 服务器部署说明

当前后台适合实验室验证和第一阶段采集。它使用SQLite，部署简单，但不应直接暴露到公网。

正式接入三台服务器时建议：

1. 使用Nginx或Caddy提供HTTPS。
2. 增加设备证书或API密钥认证。
3. 将SQLite迁移到PostgreSQL或TimescaleDB。
4. 对数据库进行自动备份和恢复演练。
5. 将AI推理独立为模型服务，设备硬报警仍保留在现场。

GitHub Pages是静态网站，只能展示页面，不能运行后台。真实设备需要连接部署在服务器上的后台地址。

## 计算模型

当前浏览器基线公式为：

```text
Rs/R0 = A × C^(-B)
C = (A / correctedRatio)^(1/B)
```

默认参数和线性温湿度补偿仅用于演示。正式投用前必须替换为具体传感器型号的标准气体标定数据。

## 安全说明

平台用于算法验证、监控和数据分析，不能单独承担安全联锁。正式产品必须在现场设备中保留硬阈值报警、故障诊断和本地输出，并完成标准气体、温湿度、交叉气体、漂移及适用认证测试。
