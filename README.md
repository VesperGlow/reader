# 页间（Rust Reader）

一个轻量私人 Web 阅读器：账户密码登录、个人书架、上传 EPUB/TXT，点击屏幕左右区域翻页。账号只用于防白嫖偷看与防爆破，没有公开注册。

## 功能

- Rust + Axum 后端，SQLite 持久化
- Argon2id 密码哈希，随机 Cookie 会话；支持在设置里修改密码
- 每个账户独立书架，支持上传、删除、长按（移动端）/ 右键（桌面）编辑
- 移动端封面书架、侧边工具栏、批量管理与书名/作者/系列搜索
- EPUB 内嵌封面与系列元数据识别（浏览器本地缓存）
- 同系列书籍自动聚合，并支持编辑书名、作者和系列顺序
- EPUB 原生目录与 TXT 章节标题自动识别、跳转
- 原生 SPA：`/`、`/read/:id`、`/series/:name`、`/settings`、`/edit` 客户端路由，深链可直接打开（服务端 fallback 返回 `index.html`，不影响 `/api/*`）
- 阅读器运行时 keep-alive 缓存（最近 1~2 本），再次打开同书不重新下载/解析
- 兼容入口 `reader.html?id=`（旧链接仍可用，主入口为 `index.html`）
- EPUB 分页渲染与阅读进度保存；底部进度条、字号与明暗调节（均会记住）
- TXT 分栏分页，自动兼容 UTF-8 和常见 GBK 编码
- 键盘方向键、PageUp/PageDown 和空格翻页

## 创建账号

没有网页注册入口，用内置命令交互式创建：

```bash
# 本地
cargo run --release -- create-admin

# 容器内（容器名假设为 reader）
docker exec -it reader rust-reader create-admin
```

按提示输入用户名（3-32 位）与密码（8-128 位，需确认一次）。账号信息写入 `READER_DATA_DIR` 下的 `reader.db`。

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

- `READER_ADDR`：监听地址，默认 `127.0.0.1:3000`。
- `READER_DATA_DIR`：数据目录（数据库与书籍），默认 `./data`。
- `READER_SECURE_COOKIE`：设为 `1`/`true` 时强制给会话 Cookie 加 `Secure`。默认会按反代透传的 `X-Forwarded-Proto: https` 自动判断；若反代没有透传该头，HTTPS 部署下请显式设为 `1`。

## 容器部署

每次推送到 `main` 会由 GitHub Actions 编译并发布镜像到 GHCR：

```bash
docker pull ghcr.io/vesperglow/reader:latest
docker run -d --name reader -p 3000:3000 -v reader-data:/app/data ghcr.io/vesperglow/reader:latest
docker exec -it reader rust-reader create-admin   # 首次创建账号
```

或本地构建：

```bash
docker compose up -d --build
```

## 部署说明

- 默认监听本机地址；公网部署请放在 Caddy/Nginx 等 HTTPS 反向代理之后，并确保透传 `X-Forwarded-For` 与 `X-Forwarded-Proto`（登录限流按真实来源计数、`Secure` Cookie 据此自动开启）。
- 内置登录限流：单一来源 5 分钟内最多 10 次尝试，超出返回 429（同时缓解针对 Argon2 的 CPU 放大攻击）。
- 全站发送 CSP 等安全响应头（脚本仅允许同源），EPUB 正文在前端清洗时移除脚本/事件处理器并剥离 `javascript:` 等危险协议链接，降低恶意 EPUB 的 XSS 风险。
- EPUB 解包组件随应用本地提供，不依赖外部 CDN。
- 上传上限为单本 64 MB，支持一次多选批量上传。
- 阅读器分页基于浏览器视口高度，不同浏览器/是否显示地址栏会使总页数略有差异，属正常现象；进度按百分比保存，跨设备打开仍会回到大致相同的位置。
- 这是私人阅读器 MVP。若开放给不受信任的公众用户，建议再加入 CSRF Token、存储配额和后台管理。
