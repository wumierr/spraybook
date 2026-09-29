# 离线同步状态机（M3 实现依据）

## 0. 目标
计算器（纯前端，file:// 或局域网 http 打开）在无服务器时照常作业，恢复连接后把"一次作业"完整上报到 server，幂等、有序、可观测、不静默失败。

## 1. 范围与硬约束
- **只同步作业执行层**（jobs + 子表）：append-only，P0 无更新同步。
- **混合内容约束**：公网 HTTPS 版（Cloudflare/CloudBase）无法 fetch 局域网 `http://` API（浏览器混合内容拦截）——同步仅在 `file://` 或局域网 `http://` 访问计算器时可用。公网版只做离线计算，同步按钮显示"当前环境不可同步"。
- 主数据/财务状态读取（bootstrap）属 M7：财务以服务器为权威（只读展示），主数据现场优先（按 name+phone upsert）。

## 2. 状态机

```
            ┌──────────── retry(退避) ───────────┐
            ▼                                    │
pending ──► syncing ──► synced(移出队列)          │
   │           │                                  │
   │           ├─ 4xx ──► failed(不重试)          │
   │           └─ 网络/5xx ─► 等待下次触发 ◄───────┘
   │                       重试 10 次仍失败 ──► dead
   └── 也可长期停留（离线），数据不丢
```

| 状态 | 含义 | UI |
|---|---|---|
| pending | 在队列等发送 | 角标"待同步 N" |
| syncing | 正在 POST | 角标变体/禁用重复点击 |
| synced | 服务器确认（或幂等重复返回） | 从队列移除，工单面板记"已同步 单号" |
| failed | 4xx 校验错，不会自愈 | 红色角标+可打开看错误详情 |
| dead | 重试 10 次仍网络/5xx | 红色角标+"一键重推"按钮 |

failed/dead **不阻塞**后续条目（作业带 job_date，报表按日归集，不依赖到达顺序）。

## 3. 队列与持久化
- localStorage 键 `drone_spray_sync_v1`：
```json
{ "v": 1, "queue": [ { "client_job_id":"uuid", "job_no":"20260929-A1B2", "payload": {...}, "created_at":"ISO", "attempts":0, "last_error":null, "status":"pending|failed|dead", "server_job_no":null } ] }
```
- 刷新/关机/重启浏览器不丢（localStorage 持久）；synced 条目立即移出队列。
- 队列 >100 条时面板黄色告警"积压过多，请尽快联网同步"。
- localStorage 容量兜底：单条 payload 含 raw_json 约 20–60KB，千条级才可能触顶；告警优先。

## 4. 在线探测（不信任 navigator.onLine）
触发时机：①入队后立即；②每 60 秒轮询；③`online` 事件与 `visibilitychange`（页面回到前台）；④用户点"同步"按钮。
探测方式：`GET /api/health`，`AbortController` 4 秒超时。成功=在线（开始 flush）；失败=离线（静默等下一轮）。

## 5. 发送与幂等
- FIFO 逐条发送；单条作业一个 `POST /api/jobs`，失败整条回队（服务端事务保证不会写半单）。
- 幂等：`client_job_id` 服务端 UNIQUE；重复返回 `{duplicated:true, job}` 按 synced 处理。
- `job_no` 服务端重生成时：回写 `server_job_no` 并在工单面板同步状态行显示最终单号（现场打印号与库号一致性靠此保证）。
- 重试：网络/5xx → 退避 1min → 5min → 30min（循环），attempts≥10 → dead；4xx → 立即 failed。

## 6. 冲突策略（P0 无更新同步，故仅两条）
1. 作业执行层 append-only：不存在"离线改了已同步作业"的场景——改错的作业在 ledger 作废（void），计算器重传新单（新 UUID）。
2. M7 主数据：现场改名/改价 = 现场优先 upsert；服务器财务状态 = 服务器权威只读。

## 7. UI 提示（不静默）
- 顶栏常驻同步角标：`待同步 N`（灰）/`失败 N`（红，可点开列表）。
- 每单工单面板：复制工单成功后即入队，状态行显示 `已同步 J20260929-A1B2` / `待同步` / `同步失败：原因`。
- 失败 toast 一次（不轰炸），详情在角标列表；dead 项提供"一键重推"与"复制错误详情"。
- 窄屏（360px）不溢出：角标用 icon+数字，列表走弹层。

## 8. server 配置
计算器侧新增设置项（localStorage `drone_spray_server_v1`）：`{ base_url: "http://192.168.x.x:8080", enabled: true }`；默认 enabled=false（未配置=完全不发请求，行为与 v4.5 一致）。
