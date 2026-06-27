# 页间（Rust Reader）

一个轻量私人 Web 阅读器：账户密码登录、个人书架、上传 EPUB/TXT，以及点击屏幕左右区域翻页。

## 功能

- Rust + Axum 后端，SQLite 持久化（公开注册已关闭）
- Argon2id 密码哈希，随机 Cookie 会话
- 每个账户独立书架，支持上传和删除
- 移动端封面书架、侧边工具栏、批量管理与书名/作者/系列搜索
- EPUB 内嵌封面与系列元数据识别（浏览器本地缓存）
- 同系列书籍自动聚合，并支持编辑书名、作者和系列顺序
- EPUB 原生目录与 TXT 章节标题自动识别、跳转
- 原生 SPA：`/`、`/read/:id`、`/series/:name`、`/settings`、`/edit` 客户端路由，深链可直接打开（服务端 fallback 返回 `index.html`，不影响 `/api/*`）
- 阅读器运行时 keep-alive 缓存（最近 1~2 本），再次打开同书不重新下载/解析
- 兼容入口 `reader.html?id=`（旧链接仍可用，主入口为 `index.html`）
- EPUB 分页渲染与阅读进度保存
- TXT 分栏分页，自动兼容 UTF-8 和常见 GBK 编码
- 键盘方向键、PageUp/PageDown 和空格翻页
- 明暗阅读主题

## 本地启动

需要 Rust 1.85 或更新版本：

```bash
cargo run --release
```

打开 <http://127.0.0.1:3000>。数据库和书籍默认保存在 `./data`。

可配置环境变量：

```bash
READER_ADDR=0.0.0.0:8080 READER_DATA_DIR=/path/to/data cargo run --release
```

## Docker

```bash
docker compose up -d --build
```

## 部署说明

- 默认监听本机地址；公网部署请放在 Caddy/Nginx 等 HTTPS 反向代理之后。
- EPUB 解包组件随应用本地提供，不依赖外部 CDN。
- 上传上限为 64 MB。
- 这是私人阅读器 MVP。若开放给不受信任的公众用户，建议再加入注册开关、登录限流、CSRF Token、存储配额和后台管理。
