# GalGames 资源站维护

站点：<https://gal.yeque.top/>，服务器 `10.0.0.211`。

Firefly 前端由 Cloudflare Pages 提供，GitHub Actions 构建并自动发布；服务器运行轻量 API，并保留迁移前的静态版本供回退，不运行 Node.js 服务。
原 WordPress 文件和数据库保留，WordPress 专用 `php8.4-fpm` 已停止并禁用开机启动。
图床使用的 PHP 8.2 和共享 MariaDB 继续运行。

## Cloudflare Pages 与实时 API 改造

前端已增加 Pages 构建与旧链接兼容，搜索及下载可以通过 `PUBLIC_GAME_API_BASE_URL` 接入实时 API；未配置时沿用原静态搜索和下载。详见 [Cloudflare Pages 部署](CLOUDFLARE-PAGES.zh-CN.md)。

服务器已运行 `galgame-api.service`，由 Python 标准库提供接口，监听回环地址 4323，经现有 Nginx 4321/4322 的 `/api/v1/` 转发。接口索引是 `/var/lib/galgame-api/catalog.json`，发布密钥只在服务器 `/etc/galgame-api.env`，没有写入源码。新服务不依赖 WordPress 或数据库。

前端已部署到 Cloudflare Pages 项目 `galgame`，Pages 地址为 <https://galgame-5si.pages.dev/>，正式域名 `gal.yeque.top` 已切换并激活。API 域名 `gal-api.yeque.top` 通过现有 Cloudflare Tunnel 连接服务器 Nginx，再代理至本机 API。GitHub Actions 首次自动发布已成功，记录：<https://github.com/kuaichu/Firefly/actions/runs/41209358164>。源码仓库 `main` 分支更新后，会自动检查、构建、同步 API 索引并上传 Pages。详细部署参数与操作见 [Cloudflare Pages 部署](CLOUDFLARE-PAGES.zh-CN.md)。

正式站的搜索和下载依赖 API；仅在完成回退或停用站点后，停止 API 可执行 `systemctl disable --now galgame-api.service`，并恢复 `.migration/api/deployment.json` 所记录服务器备份目录内的两份 Nginx 配置，然后 `nginx -t && systemctl reload nginx`。这不会切换正式前端版本。原服务器静态版本继续保留供回退。

## 内容与构建

- 文章位于 `src/content/posts/wp-<原文章ID>.md`，正文可直接修改。
- `legacySlug` 与 `src/data/wordpress-legacy.json` 用于兼容原 WordPress 地址，不要随意改名。
- 图片原路径位于 `public/wp-content/uploads/`；轻量封面位于 `public/covers/`。
- `gameYear` 是可选的游戏发行年份，仅填写已确认的年份；不根据文章发布时间推断。
- 新文章可通过 `pnpm new-post <文件名>` 创建，默认位于 `/posts/<文件名>/`。
- 本地检查和预览使用 `pnpm check`、`pnpm type-check`、`pnpm build:pages`，最终产物是 `dist/`。正式发布由推送 `main` 后的 GitHub Actions 完成。
- 网页后台入口为 <https://gal.yeque.top/admin/>，使用 GitHub 登录 Pages CMS 管理游戏、图片与下载链接。保存后自动发布，首次使用需管理员仅授权本站仓库，详见 [后台使用说明](CMS.zh-CN.md)。仍可直接修改文件并推送 `main`。

下载按钮可以沿用以下正文 HTML，多个版本放在同一面板内：

```html
## 下载资源

<div class="resource-downloads" data-pagefind-ignore>
<p>选择对应版本下载。</p>
<div class="resource-download-actions">
<a class="resource-download" href="https://example.com/game-file" target="_blank" rel="noopener noreferrer">PC版 ↗</a>
</div>
</div>
```

上述示例 URL 需要替换为真实下载链接。

## 发布与回退

源码及 Pages 发布自动化目标仓库为 <https://github.com/kuaichu/Firefly> 的 `main` 分支。GitHub Actions 负责检查、构建、临时 API 验证、同步后端索引，并将 `dist/` 上传至现有 Pages 项目 `galgame`；Pages 项目本身使用 Wrangler 上传，不是 Pages Git 集成。首次自动发布和公网 API 已通过验证。以下服务器 release 管理仅用于保留的回退静态站，不会更新当前 Pages 正式站。

服务器目录：

- `/opt/galgame-firefly/releases/`：各版本静态产物。
- `/opt/galgame-firefly/current`：正式站当前版本的符号链接。
- `/opt/galgame-firefly/preview`：首版预览链接，内网端口 4322，禁止搜索引擎收录。
- `/etc/nginx/sites-available/galgame-firefly.conf`：正式站，复用端口 4321。
- `/etc/nginx/conf.d/galgame-firefly-maps.conf`：旧文章、分类、标签、分页等兼容映射。
- `/var/backups/galgame-firefly-20261031-160133/`：原 WordPress 完整文件、SQL、原 Nginx 配置及切换前的站点附件。

上传新的 `dist/` 到新的 release 目录后，可执行以下服务器命令选择版本：

```sh
python3 /opt/galgame-firefly/update-release.py /opt/galgame-firefly/releases/<新版本目录>
```

不要覆盖正在使用的 release。运行发布验证：

```sh
python scripts/verify-static.py --base http://10.0.0.211:4321
node scripts/verify-search.mjs http://10.0.0.211:4321
```

如需恢复原 WordPress，先在服务器执行下列命令，再将 `gal.yeque.top` 的 CNAME 恢复为 `c89be1e5-47c3-4182-8f51-2afa625260e8.cfargotunnel.com`（开启代理）：

```sh
python3 /opt/galgame-firefly/rollback.py /var/backups/galgame-firefly-20261031-160133
```

该脚本重新启动 PHP 8.4，恢复原 Nginx 站点附件并检查后重载；不覆盖任何数据库或内容。
Firefly 版本之间回退则使用 `update-release.py` 选择保留的旧版本即可。

## 迁移记录与限制

已迁移 111 篇文章、429 个媒体附件记录、138 个下载按钮、分类标签和 18 篇文章的发行年份。
111 个原文章地址直接提供内容；旧分类/标签、`?p=`、`?s=`、`?game_year=` 及分页地址通过 Nginx 兼容。

原站存在 48 张图片原文件损坏，其中 24 张封面无可用缩略图；损坏原文件没有删除。
现已按游戏及版本从 VNDB 与发行商 Steam 商店补齐 30 款游戏的 24 张封面和 48 处预览图，
全部转换为本地 WebP，竖版封面保留完整画面并补以同图模糊背景。
来源、作品匹配依据、图片尺寸及校验值见 `src/data/media-repairs.json`；历史损坏记录见 `media-issues.json`。
替换封面位于 `public/covers/`，补充预览图位于 `public/game-media/`，文章内保留资料来源链接。

随后逐张检查了全站 111 个封面，并替换 84 个原本以标题菜单、窗口截图或不合适配图充当封面的记录。
优先使用正式 Steam 横版宣传图，其余采用同作品正式包装图；少数无合适包装图的作品使用已核对的角色插画，裁去对话框和控件。
近月 2.1/2.2 合集封面同时展示两部作品，主作、后传和移植版分别核对。
本轮来源和图片校验值见 `src/data/cover-refresh.json`。详情页封面显示宽度限制为 960px，避免小图被无限放大。
《V.G. NEO》暂未找到构图完整、适合公开展示的更清晰替代封面，保留原图；两张原本适用的宣传封面也予以保留。
《夏之雨》原文没有实际下载链接，当前如实显示暂无下载链接。

`scripts/export-wordpress.py` 和 `scripts/import-wordpress.py` 仅用于重新迁移，重新导入会重写生成的文章，
不要把导入当作日常构建步骤。原始导出、图片匹配及审计记录位于本机忽略目录 `.migration/`。
重新导入会恢复到修复前内容；仅在明确需要重新迁移时使用，并重新应用图片修复记录。
没有在源码中保存服务器密码、WordPress 密钥或数据库凭据。

验证覆盖 Astro 检查、类型检查、生产构建、全部旧文章的 HTTP 请求、重定向和 Pagefind 实际搜索。
没有操作用户浏览器，也没有进行浏览器视觉验收。

主题来源：<https://github.com/CuteLeaf/Firefly>，保留上游 MIT License 和署名。
