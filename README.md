# 国际象棋

创建房间后分享邀请链接或 8 位房号。房主执白，好友执黑。对局可以不限时，也可以给每方 1、3、5、10、15、30 或 60 分钟。对局结束后可以复盘、分享复盘链接或下载标准 PGN。双方确认再战后交换执棋颜色。

规则由 [chess.js 1.4.0](https://github.com/jhlywa/chess.js/releases/tag/v1.4.0) 判定，支持王车易位、吃过路兵和四种升变。僵局、子力不足、三次重复局面及五十步规则均自动判和。计时房超时的一方判负。网页和服务端依赖都随项目提供。上游 BSD-2-Clause 授权见 [LICENSE](vendor/LICENSE)。

## 本地运行

安装 Node.js 24 或更新版本，在本目录运行 `npm start`，打开 `http://127.0.0.1:18887/`。用两个独立的浏览器会话测试双方入座。默认数据库是本目录下的 `rooms.sqlite`。可用 `PORT` 和 `DB_PATH` 指定测试端口和数据库。

Windows 公网入口由 GameHub 本地网关 `gamehub-local/public-gateway.cjs`（不在本仓库）提供。网关启动国际象棋后端（端口 `18888`），并使用独立的 `gamehub-local/copy/chess.sqlite`。邀请链接使用打开游戏的 GameHub 地址。

## Moon 部署

1. 将 `server.cjs`、`public/`、`vendor/` 放入 `/opt/chess/releases/<版本>/`。将 `/opt/chess/current` 指向该版本并安装 [systemd 单元](gamehub-chess.service)。单元使用 Moon 的 Node 24 运行时，把数据库放在独立的 `/var/lib/gamehub-chess/`。
2. 在 GameHub 的静态文件路由之前添加以下 Caddy 路由，保留请求路径。

   ```caddyfile
   redir /gamehub/chess /gamehub/chess/ 308
   handle /gamehub/chess/* {
       reverse_proxy 127.0.0.1:18887 {
           flush_interval -1
       }
   }
   ```

3. 验证 `/gamehub/chess/health`，再用两个独立会话验证建房、走子和棋谱下载。随后按 GameHub 的发布流程（不在本仓库）更新目录页。

`gamehub-chess.service` 写死了 moon 的环境：Node 运行时路径（借用 `/opt/pokemon-showdown/runtime/current/bin/node`）、
发布目录 `/opt/chess/current` 和公网来源 `https://release.moonl.cloud`。在别处部署时按实际环境修改。

## CI

项目没有 npm 依赖、构建步骤和自动化测试。GitHub Actions 在每次推送和 PR 时运行标准 Node 检查（目前只有安装）以及密钥与依赖漏洞扫描。

## 许可证

本仓库代码以 [MIT](LICENSE) 发布。`vendor/chess.cjs` 来自 chess.js 1.4.0，保留其 BSD-2-Clause 许可证（[vendor/LICENSE](vendor/LICENSE)），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
