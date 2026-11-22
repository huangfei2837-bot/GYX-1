# GYX-1 数据服务器

使用 Node.js 24 或更新版本运行，不需要安装第三方依赖。

```powershell
node backend/server.js
```

默认地址为 `http://0.0.0.0:8080`，数据库保存在 `backend/gyx1.sqlite`。

另开一个终端发送演示设备数据：

```powershell
node backend/demo-sender.js
```

然后访问 `http://127.0.0.1:8080`，选择“实时设备”，检测服务器并连接 `GYX-1-001`。

## 设备上报接口

```text
POST /api/telemetry
```

最小数据：

```json
{
  "device_id": "GYX-1-001",
  "sequence": 1,
  "vout": 2.5,
  "temperature": 25,
  "humidity": 50,
  "heater_voltage": 1.8,
  "heater_current": 32,
  "fault_code": 0,
  "firmware_version": "1.0.0"
}
```

## 查询接口

```text
GET /health
GET /api/devices
GET /api/devices/GYX-1-001/latest
GET /api/devices/GYX-1-001/history?limit=300
WS  /api/realtime?device_id=GYX-1-001
```

## 环境变量

```text
GYX1_HOST                 默认 0.0.0.0
GYX1_PORT                 默认 8080
GYX1_DB                   SQLite数据库路径
GYX1_ALLOWED_ORIGIN       允许访问API的网站来源，默认 *
GYX1_ONLINE_TIMEOUT_MS    在线超时时间，默认15000毫秒
```

生产服务器需要由 Nginx 或 Caddy 提供 HTTPS，并将 `GYX1_ALLOWED_ORIGIN` 设置为实际网站地址。

