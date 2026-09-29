# spraybook 部署运维一页纸（P0）

> 给记账人/老板看的运维说明。系统 = 计算器（现场，手机/平板）+ 记账后台（记账人电脑）+ 一个 Node 服务 + 一个 SQLite 文件。

## 1. 服务器放哪（P0 默认）

**记账人的 Windows 电脑**，局域网内使用：现场手机与电脑连同一个 Wi-Fi。

- 启动：双击根目录 **`启动spraybook服务.bat`**（或 `cd server && npm start`）
- 计算器（现场手机浏览器打开）：`http://<电脑IP>:8080/`
- 记账后台：`http://<电脑IP>:8080/ledger/`（本机就是 `http://127.0.0.1:8080/ledger/`）
- 查电脑 IP：`ipconfig` 看 IPv4 地址（如 192.168.1.5）
- 第一次使用：防火墙弹窗选"允许访问"（放行 8080 入站）；不想弹就管理员运行：
  `netsh advfirewall firewall add rule name="spraybook" dir=in action=allow protocol=TCP localport=8080`

上云（腾讯云轻量等）为可选后续，届时必须加访问口令 + HTTPS（M9+）。

## 2. 计算器如何连上账本（同步开启）

计算器页面按 F12 无法改——用 localStorage 配置（现场手机上可先在电脑配置后导出分享码，或直接在手机地址栏执行一次）：

```js
localStorage.setItem('drone_spray_server_v1', JSON.stringify({base_url:'http://192.168.1.5:8080', enabled:true}))
```

- 配置后：工单面板出现"☁️ 同步到账本"按钮；复制工单也会自动入队。
- **混合内容约束**：公网 HTTPS 版计算器（Cloudflare/CloudBase）无法请求局域网 http——同步只在 `file://` 打开或局域网 `http://<电脑IP>:8080/` 访问时可用。
- 未配置/断网：计算器照常离线用，作业在本地排队（localStorage，关机不丢），联网自动补传。

## 3. 备份（每日一次）

数据全在 `data/app.db` 一个文件。

```bash
cd server && npm run db:backup    # 生成 backups/app-YYYYMMDD.db，自动保留最近 30 份
```

自动每日备份（管理员 PowerShell 一次性设置，09:30 执行）：

```powershell
schtasks /create /tn "spraybook备份" /sc daily /st 09:30 /tr "cmd /c cd /d D:\agent work\works\spraybook\server && npm run db:backup"
```

⚠️ 不要在服务运行时直接复制 `app.db`（WAL 模式下可能不一致）——一律用 `db:backup`（SQLite backup API，在线一致）。

## 4. 故障应急

| 情况 | 处理 |
|---|---|
| 服务器挂了/电脑没开 | **现场不受影响**：计算器离线作业、本地排队；服务恢复后自动补传（可排队任意天数） |
| 数据库坏了 | 关服务 → 删 `data/app.db` → 把最近 `backups/app-*.db` 复制回 `data/app.db` → 重启 |
| 想清空重练 | `cd server && npm run db:reset`（**会清掉全部数据**，先备份） |
| 手机连不上 | 确认同一 Wi-Fi、服务窗口开着、防火墙放行、地址是电脑 IP 不是 127.0.0.1 |
| 端口被占 | `set PORT=8081` 后再 `npm start`（或改 bat） |

## 5. 数据安全（P0 边界）

- 默认仅局域网，不暴露公网；客户电话、欠款、价格不出内网。
- 无登录口令（P0 不做多角色）——所以**不要把 8080 端口映射到公网**。
- 上云时必须：加口令（M7+）+ HTTPS + 数据库每日云备份。

## 6. 本机开发/安装备注（这台电脑）

- Node v20.17 在 `D:\nodejs`（未进系统 PATH，cmd 子进程找不到裸 `node`）→ **装依赖必须**：
  ```bash
  cd server && npm install --ignore-scripts
  cd node_modules/better-sqlite3 && node ../prebuild-install/bin.js && cd ../..
  ```
  （`启动spraybook服务.bat` 已自动处理）
- CloudBase 的 CNB 流水线目前整仓 `./` 部署：**行动项——改为部署 `dist/`**，切换前不要在装了 node_modules 后整仓重推 CloudBase。
- Cloudflare/GitHub Pages 工作流已在 spraybook main 移除；公网部署路线 M9 重规划。

## 7. 数据回滚基线

- `main` 分支每个里程碑一提交；远程 `wumierr/spraybook`。
- 数据库结构与种子：`server/db/migrations/`（只增不改）+ `seed.sql`；重建：`npm run db:reset`。
