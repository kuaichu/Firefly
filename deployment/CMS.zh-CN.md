# 网页内容管理

入口：<https://gal.yeque.top/admin/>。

本站使用开源 [Pages CMS](https://pagescms.org/) 的托管后台，内容保存在自己的 GitHub 仓库，不在服务器新增 CMS 进程或数据库。

## 首次登录

1. 点击“使用 GitHub 登录管理后台”，使用有 `kuaichu/Firefly` 写入权限的 GitHub 账号登录。
2. 按提示安装 Pages CMS 的 GitHub App，选择 **Only select repositories**，仅授权 `kuaichu/Firefly`。
3. 打开 `main` 分支下的“游戏资源”。配置已经在仓库根目录 `.pages.yml`，无需再创建字段。

GitHub 授权由管理员本人完成；不要把 GitHub 密码、Cloudflare Token 或游戏 API 发布密钥填入 CMS。

## 编辑与发布

- 标题、摘要、分类、标签、发行年份可直接填写；未知发行年份留空。
- “封面”和“预览截图”可以选择已有图片或上传新图。图片使用随机文件名，避免替换后仍命中旧缓存；单张建议小于 20 MB。
- “游戏介绍与补充说明”是富文本编辑器。原有资料来源仍保留在正文中；截图和下载不再需要编辑 HTML。
- “预览截图”的“所属作品或版本”用于合集分组，普通作品留空。
- “下载资源”每个版本添加一项，填写按钮名称与完整下载地址。实际游戏安装包继续放在原文件服务器。
- “暂不公开（草稿）”保存后会从正式站和搜索 API 隐藏，取消草稿后再次发布；删除也会同步到后续部署。原站固定地址和文件名已锁定，避免普通编辑破坏旧链接。
- 点击保存会提交到 `main`，GitHub Actions 自动检查、构建、同步 API 索引并部署 Pages，通常需要几分钟。可通过入口的“查看发布进度”确认结果。

CMS 可以创建新游戏，文件名自动生成，新文章使用 `/posts/<文件名>/`。迁移的旧文章继续使用原 WordPress 地址。

## 存储与兼容

- `.pages.yml`：表单、媒体上传及字段合并配置，使用 `settings.content.merge: true` 保护已有字段。
- `src/content/posts/`：文章；`screenshots`、`downloads` 是结构化字段。
- `public/covers/`、`public/game-media/`、`public/uploads/`：上传封面、截图与正文图片，所有图片的公开路径从 `/` 开始。
- `src/components/layout/GameResources.astro`：页面与订阅源共用的截图/下载渲染。
- `scripts/export-game-api.mjs`：生成后端索引，兼容旧正文按钮和新的结构化下载字段。
- `scripts/migrate-cms-fields.mjs`：一次性迁移脚本，默认仅检查；已迁移内容复跑不会重写。不要把它作为日常发布步骤。

111 篇文章的 417 张截图、138 个下载入口、封面、原发布时间和资料来源均已保留。迁移审计与原始正文备份在本机忽略目录 `.migration/cms/`。

后台实际操作需要管理员登录 Pages CMS；没有使用用户浏览器代为完成登录授权或视觉验收。
