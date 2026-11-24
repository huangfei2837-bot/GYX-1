# GYX-1 数据服务器

使用 Node.js 24 或更新版本运行。首次启动前安装依赖：

```powershell
npm install
```

```powershell
node backend/server.js
```

默认地址为 `http://0.0.0.0:8080`，数据库保存在 `backend/gyx1.sqlite`。

## 连接MQTT

后台订阅 `gyx1/+/telemetry`，收到数据后写入SQLite并通过WebSocket推送到网页。账号密码只能通过环境变量提供，不能写进代码或提交到GitHub。

```powershell
$env:GYX1_MQTT_URL = "mqtt://192.168.1.112:1883"
$env:GYX1_MQTT_USERNAME = "后台账号"
$env:GYX1_MQTT_PASSWORD = "后台密码"
node backend/server.js
```

ESP32发布主题示例：`gyx1/GYX-1-001/telemetry`。JSON中的`device_id`可以省略；如果填写，必须与主题中的设备编号一致。

没有ESP32时，可以使用设备账号执行一次MQTT模拟发布：

```powershell
npm run mqtt:demo
```

该程序只发布一条标记为`mqtt-test-1.0.0`的测试数据，不包含伪造的AI计算结果。

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
GET /api/mqtt/status
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
GYX1_MQTT_URL             MQTT地址，例如mqtt://192.168.1.112:1883
GYX1_MQTT_USERNAME        MQTT后台订阅账号
GYX1_MQTT_PASSWORD        MQTT后台订阅密码
GYX1_MQTT_TOPIC           订阅主题，默认gyx1/+/telemetry
```

生产服务器需要由 Nginx 或 Caddy 提供 HTTPS，并将 `GYX1_ALLOWED_ORIGIN` 设置为实际网站地址。

## Ubuntu用户目录部署

`deployment/`中的脚本支持把后台部署到普通Ubuntu用户目录：

- `start-gyx1.sh`：读取受保护的MQTT凭据并启动后台。
- `launch-gyx1.sh`：避免重复进程，后台启动并记录PID和日志。
- `stop-gyx1.sh`：停止当前后台进程。

服务器目录约定为`~/gyx1`，共享数据库位于`~/gyx1/data`，发布版本位于`~/gyx1/releases`。凭据文件权限必须为`600`，不得提交到GitHub。

