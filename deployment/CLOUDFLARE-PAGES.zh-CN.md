# Cloudflare Pages 部署

本项目部署为 Cloudflare Pages 项目 `galgame`，默认预览地址为 <https://galgame-5si.pages.dev/>，自定义域名 `gal.yeque.top` 已附加到项目。前端当前通过 Wrangler 直接上传；域名 DNS 尚未切换，切换前正式站仍由服务器提供。该项目是直接上传创建的，不能改成 Cloudflare Pages Git 集成。自动发布由 GitHub Actions 构建后调用 Wrangler 上传到现有 Pages 项目。

Actions 构建使用 Node.js 22.23 或更新版本、pnpm 11，运行检查、类型检查、Pages 构建和临时 API 验证，再将 API 索引同步到后端并执行 `wrangler pages deploy dist --project-name galgame --branch main`。工作流使用 GitHub Actions 变量 `CLOUDFLARE_ACCOUNT_ID`、`PUBLIC_GAME_API_BASE_URL`，以及仓库密钥 `CLOUDFLARE_API_TOKEN`、`GAME_API_PUBLISH_TOKEN`。不要将这些密钥写入源码或文档。工作流及首次自动发布尚待验证通过；验证成功后再切换 `gal.yeque.top` DNS。

构建变量 `PUBLIC_GAME_API_BASE_URL` 当前设为 `https://gal-api.yeque.top/api/v1`；前端在构建时将该值写入静态资源。`gal-api.yeque.top` 的 DNS CNAME 指向现有 Cloudflare Tunnel `c89be1e5-47c3-4182-8f51-2afa625260e8.cfargotunnel.com`，隧道将请求送至服务器 `10.0.0.211:4321`。Nginx 再将 `/api/v1/` 代理到仅监听回环地址的 Python API `4323`。公网 DNS 不应直接指向内网 IP。

GitHub Actions 密钥 `GAME_API_PUBLISH_TOKEN` 与服务器 `/etc/galgame-api.env` 中的值一致；只供构建结束时同步 API 索引，不写入静态文件。每次推送到 `main` 或手动运行工作流时，会从同一批 Markdown 生成静态文章和 API 索引，并通过带鉴权的 POST 同步后端。同步失败则工作流失败，停止这次 Pages 发布。普通 `pnpm build:pages` 只在本地生成产物，方便检查，不写远端。

构建前确保 `CF_WORKERS` 未设置。构建脚本会在 Astro 导出完成后生成 `dist/_redirects`，覆盖 WordPress 文章 ID、旧 slug、分类/标签、旧分页、站点地图和 feed 路径，并检查每个目标都对应实际导出的页面。`functions/_middleware.ts` 处理首页查询参数 `p`、`s` 和 `game_year`，分别转向文章、搜索和年份归档；`dist/_routes.json` 把 Function 范围限制在首页，使其他路径继续由 Pages 静态资源及 `_redirects` 处理。

Wrangler 配置位于 `wrangler.jsonc`，可用于本地 Pages 命令。需要本地登录时，使用仓库安装的 Wrangler CLI（Windows 上可用 `D:\Program\Tools\nodejs\node.exe node_modules/wrangler/bin/wrangler.js login`），不要依赖用户级 `pnpm` 命令是否在 PATH 中。生产发布由 GitHub Actions 完成；Cloudflare Pages 项目本身不连接 Git。请勿将 `CF_WORKERS` 设置为构建变量。

后端为 `deployment/game-api.py`，仅使用 Python 标准库；systemd 单元为 `deployment/galgame-api.service`。公开读取接口包括 `GET /api/v1/healthz`、`GET /api/v1/search?q=...`、`GET /api/v1/games/<id>/downloads`、`GET /api/v1/games/<id>/downloads/<序号>`，最后一个以 302 转向原文件服务，不转发游戏文件。`POST /api/v1/catalog` 需要发布密钥，经过校验后原子替换 `/var/lib/galgame-api/catalog.json`，服务会实时加载更新。CORS 允许的前端域名在服务器环境文件的 `GAME_API_ORIGINS` 中按逗号分隔；Pages 预览域名确认后需加入该清单。

本地验证：`pnpm check`、`pnpm type-check`、`pnpm build:pages`、`pnpm verify:api`。最后一个会启动独立临时 API，验证搜索、全部下载目标、跨域、鉴权和索引热加载；不会修改正式索引。远端验证可用 `python scripts/verify-game-api.py --base https://gal-api.yeque.top/api/v1`。

准备脚本会报告静态文件数量和最大的文件，并在超过 Pages 每次部署 20,000 个静态资源或单文件 25 MiB 限制时失败。脚本只生成 `_redirects`，不会删除 `public` 中的内容。
