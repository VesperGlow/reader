use std::{collections::HashMap, net::SocketAddr, path::{Path, PathBuf}, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

use argon2::{Argon2, password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString}};
use axum::{
    Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path as AxumPath, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
};
use async_compression::Level;
use async_compression::tokio::bufread::{ZstdDecoder, ZstdEncoder};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{fs, io::{AsyncReadExt, AsyncWriteExt, BufReader}, net::TcpListener, sync::Semaphore};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

type DbPool = r2d2::Pool<SqliteConnectionManager>;

const INDEX_HTML: &str = include_str!("../static/index.html");
const READER_HTML: &str = include_str!("../static/reader.html");
const APP_CSS: &str = include_str!("../static/app.css");
const APP_JS: &str = include_str!("../static/app.js");
const READER_CACHE_JS: &str = include_str!("../static/reader-cache.js");
const READER_JS: &str = include_str!("../static/reader.js");
const ROUTER_JS: &str = include_str!("../static/router.js");
const JSZIP_JS: &str = include_str!("../static/vendor/jszip.min.js");
const MAX_BOOK_SIZE: usize = 64 * 1024 * 1024;
const SESSION_SECONDS: i64 = 30 * 24 * 60 * 60;
// 登录限速：单一来源在窗口内最多尝试次数，超出后返回 429（同时挡住对 Argon2 的 CPU 放大攻击）。
const LOGIN_MAX_ATTEMPTS: u32 = 10;
const LOGIN_WINDOW_SECONDS: i64 = 300;
// 限速表最多跟踪多少个来源 key：防止伪造 X-Forwarded-For 灌入海量不同 key 撑爆内存。
const LOGIN_MAX_TRACKED_IPS: usize = 4096;
// 同时进行的 Argon2 哈希数上限：每次哈希约占 19MB，限并发把内存峰值钉死在小盒子能承受的范围。
const MAX_CONCURRENT_HASHES: usize = 2;
const SECURITY_HEADER_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

#[derive(Clone)]
struct AppState {
    db: DbPool,
    books_dir: Arc<PathBuf>,
    login_attempts: Arc<std::sync::Mutex<HashMap<String, LoginAttempt>>>,
    // 用户名不存在时拿它跑一次等价的 Argon2 校验，抹平时序，避免用户名枚举。
    dummy_hash: Arc<String>,
    // 强制给会话 Cookie 加 Secure（READER_SECURE_COOKIE=1）；否则按 X-Forwarded-Proto 自动判断。
    force_secure_cookie: bool,
    // 限制并发 Argon2 哈希数，给内存峰值封顶（每次哈希约 19MB）。
    hash_limit: Arc<Semaphore>,
}

struct LoginAttempt {
    count: u32,
    reset_at: i64,
}

#[derive(Debug)]
struct AppError(StatusCode, String);

impl AppError {
    fn bad_request(message: impl Into<String>) -> Self { Self(StatusCode::BAD_REQUEST, message.into()) }
    fn unauthorized() -> Self { Self(StatusCode::UNAUTHORIZED, "请先登录".into()) }
    fn internal(message: impl Into<String>) -> Self { Self(StatusCode::INTERNAL_SERVER_ERROR, message.into()) }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(ApiMessage { message: self.1 })).into_response()
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Serialize)]
struct ApiMessage { message: String }

#[derive(Deserialize)]
struct AuthInput { username: String, password: String }

#[derive(Deserialize)]
struct PasswordChange { current_password: String, new_password: String }

#[derive(Serialize)]
struct Me { id: i64, username: String }

#[derive(Serialize)]
struct Book {
    id: i64,
    title: String,
    kind: String,
    size: i64,
    created_at: i64,
    author: Option<String>,
    series_name: Option<String>,
    series_index: Option<f64>,
    updated_at: i64,
    reading_progress: Option<i64>,
}

#[derive(Deserialize)]
struct BookUpdate {
    title: Option<String>,
    author: Option<String>,
    series_name: Option<String>,
    series_index: Option<f64>,
    #[serde(default)]
    clear_series_index: bool,
}

#[derive(Deserialize)]
struct ProgressInput {
    page: i64,
    total_pages: Option<i64>,
}

#[derive(Serialize)]
struct Progress {
    page: i64,
    total_pages: Option<i64>,
}

#[tokio::main]
async fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("create-admin") | Some("create-user") => create_user_cli(),
        _ => run().await,
    };
    if let Err(error) = result {
        eprintln!("错误: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var("READER_DATA_DIR").unwrap_or_else(|_| "data".into());
    let data_dir = PathBuf::from(data_dir);
    let books_dir = data_dir.join("books");
    fs::create_dir_all(&books_dir).await?;

    // 先用单连接建表/迁移（WAL 是持久化到库文件的，对后续所有连接生效），随后切到连接池。
    drop(open_database(&data_dir)?);
    let manager = SqliteConnectionManager::file(data_dir.join("reader.db"))
        // foreign_keys 是“按连接”生效的，池里每条连接都要重新打开；busy_timeout 让并发写时不要立刻 SQLITE_BUSY；
        // synchronous=NORMAL 在 WAL 下官方认证安全（仅断电时可能丢最后一两条提交），大幅减少频繁进度写入的 fsync。
        .with_init(|connection| connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;"));
    let pool = r2d2::Pool::builder().max_size(8).build(manager)?;

    let dummy_salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|error| format!("生成时序盐失败: {error}"))?;
    let dummy_hash = Argon2::default().hash_password(b"timing-equalizer", &dummy_salt).map_err(|error| format!("生成时序哈希失败: {error}"))?.to_string();
    let force_secure_cookie = matches!(
        std::env::var("READER_SECURE_COOKIE").ok().as_deref(),
        Some("1") | Some("true") | Some("yes")
    );

    let state = AppState {
        db: pool,
        books_dir: Arc::new(books_dir),
        login_attempts: Arc::new(std::sync::Mutex::new(HashMap::new())),
        dummy_hash: Arc::new(dummy_hash),
        force_secure_cookie,
        hash_limit: Arc::new(Semaphore::new(MAX_CONCURRENT_HASHES)),
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/reader", get(reader_page))
        .route("/app.css", get(css))
        .route("/app.js", get(app_js))
        .route("/reader-cache.js", get(reader_cache_js))
        .route("/reader.js", get(reader_js))
        .route("/router.js", get(router_js))
        .route("/vendor/jszip.min.js", get(jszip_js))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/password", post(change_password))
        .route("/api/books", get(list_books).post(upload_book))
        .route("/api/books/{id}", delete(delete_book).patch(update_book))
        .route("/api/books/{id}/file", get(book_file))
        .route("/api/books/{id}/progress", get(get_progress).put(save_progress))
        .fallback(spa_fallback)
        .layer(DefaultBodyLimit::max(MAX_BOOK_SIZE + 1024 * 1024))
        .layer(middleware::from_fn(security_headers))
        .with_state(state);

    let address = std::env::var("READER_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = TcpListener::bind(&address).await?;
    println!("Rust Reader: http://{address}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

// 给每个响应加安全响应头：CSP（脚本仅同源，挡注入脚本/事件处理器）、禁嗅探、禁内嵌。
async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(SECURITY_HEADER_CSP));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

async fn index() -> Html<&'static str> { Html(INDEX_HTML) }
async fn reader_page() -> Html<&'static str> { Html(READER_HTML) }
async fn css() -> impl IntoResponse { ([(header::CONTENT_TYPE, "text/css; charset=utf-8")], APP_CSS) }
async fn app_js() -> impl IntoResponse { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], APP_JS) }
async fn reader_cache_js() -> impl IntoResponse { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], READER_CACHE_JS) }
async fn reader_js() -> impl IntoResponse { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], READER_JS) }
async fn router_js() -> impl IntoResponse { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], ROUTER_JS) }
async fn jszip_js() -> impl IntoResponse { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")], JSZIP_JS) }

// SPA fallback：未匹配的 /api/* 返回 404 JSON（不被吞掉），其余路径返回 index.html。
async fn spa_fallback(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(ApiMessage { message: "未找到".into() })).into_response();
    }
    Html(INDEX_HTML).into_response()
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<AuthInput>,
) -> AppResult<Response> {
    let ip = client_ip(&headers, Some(addr));
    rate_limit_check(&state, &ip)?;
    let record = {
        let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
        db.query_row("SELECT id, password_hash FROM users WHERE username = ?1", [input.username.trim()], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .optional().map_err(|_| AppError::internal("登录失败"))?
    };
    // 进入 Argon2 前抢一个名额：限并发把内存峰值钉死（即便限速被伪造 IP 绕过，也无法靠并发哈希拖垮内存）。
    let _hash_permit = state.hash_limit.acquire().await.map_err(|_| AppError::internal("登录失败"))?;
    let Some((user_id, stored_hash)) = record else {
        // 用户不存在也跑一次等价的 Argon2 校验，让响应时间与"密码错误"一致，避免用户名枚举。
        if let Ok(parsed) = PasswordHash::new(state.dummy_hash.as_str()) {
            let _ = Argon2::default().verify_password(input.password.as_bytes(), &parsed);
        }
        return Err(AppError::bad_request("用户名或密码错误"));
    };
    let parsed = PasswordHash::new(&stored_hash).map_err(|_| AppError::internal("账户密码数据无效"))?;
    if Argon2::default().verify_password(input.password.as_bytes(), &parsed).is_err() {
        return Err(AppError::bad_request("用户名或密码错误"));
    }
    rate_limit_reset(&state, &ip);
    session_response(&state, user_id, "登录成功", cookie_secure(&state, &headers)).await
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    if let Some(token) = cookie_value(&headers, "reader_session") {
        let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
        db.execute("DELETE FROM sessions WHERE token_hash = ?1", [hash_token(&token)])
            .map_err(|_| AppError::internal("退出失败"))?;
    }
    let mut response = Json(ApiMessage { message: "已退出".into() }).into_response();
    let cookie = build_session_cookie("", 0, cookie_secure(&state, &headers));
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).map_err(|_| AppError::internal("退出失败"))?);
    Ok(response)
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Me>> {
    let (id, username) = authenticated_user(&state, &headers).await?;
    Ok(Json(Me { id, username }))
}

async fn change_password(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<PasswordChange>) -> AppResult<Json<ApiMessage>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let new_length = input.new_password.chars().count();
    if !(8..=128).contains(&new_length) {
        return Err(AppError::bad_request("新密码长度需为 8 到 128 位"));
    }
    let stored_hash = {
        let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
        db.query_row("SELECT password_hash FROM users WHERE id = ?1", [user_id], |row| row.get::<_, String>(0))
            .optional().map_err(|_| AppError::internal("读取账户失败"))?
    }.ok_or_else(AppError::unauthorized)?;
    // 同登录：把校验旧密码 + 哈希新密码这两次 Argon2 纳入并发名额，封住内存峰值。
    let _hash_permit = state.hash_limit.acquire().await.map_err(|_| AppError::internal("更新密码失败"))?;
    let parsed = PasswordHash::new(&stored_hash).map_err(|_| AppError::internal("账户密码数据无效"))?;
    if Argon2::default().verify_password(input.current_password.as_bytes(), &parsed).is_err() {
        return Err(AppError::bad_request("当前密码错误"));
    }
    let salt_seed = Uuid::new_v4();
    let salt = SaltString::encode_b64(salt_seed.as_bytes()).map_err(|_| AppError::internal("生成密码盐失败"))?;
    let new_hash = Argon2::default().hash_password(input.new_password.as_bytes(), &salt)
        .map_err(|_| AppError::internal("密码哈希失败"))?.to_string();
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    db.execute("UPDATE users SET password_hash = ?1 WHERE id = ?2", params![new_hash, user_id])
        .map_err(|_| AppError::internal("更新密码失败"))?;
    Ok(Json(ApiMessage { message: "密码已修改".into() }))
}

async fn list_books(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Vec<Book>>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    let mut statement = db.prepare(
        "SELECT books.id, books.title, books.kind, books.size, books.created_at,
                books.author, books.series_name, books.series_index,
                COALESCE(books.updated_at, books.created_at),
                CASE
                    WHEN reading_progress.book_id IS NULL THEN NULL
                    WHEN reading_progress.total_pages = 1 THEN 100
                    WHEN reading_progress.total_pages > 1 THEN CAST(MIN(100, MAX(0, ROUND(100.0 * reading_progress.page / (reading_progress.total_pages - 1)))) AS INTEGER)
                    ELSE 0
                END
         FROM books
         LEFT JOIN reading_progress ON reading_progress.book_id = books.id AND reading_progress.user_id = books.user_id
         WHERE books.user_id = ?1
         ORDER BY COALESCE(books.updated_at, books.created_at) DESC",
    )
        .map_err(|_| AppError::internal("读取书架失败"))?;
    let rows = statement.query_map([user_id], |row| {
        Ok(Book {
            id: row.get(0)?,
            title: row.get(1)?,
            kind: row.get(2)?,
            size: row.get(3)?,
            created_at: row.get(4)?,
            author: row.get(5)?,
            series_name: row.get(6)?,
            series_index: row.get(7)?,
            updated_at: row.get(8)?,
            reading_progress: row.get(9)?,
        })
    })
        .map_err(|_| AppError::internal("读取书架失败"))?;
    let books = rows.collect::<Result<Vec<_>, _>>().map_err(|_| AppError::internal("读取书架失败"))?;
    Ok(Json(books))
}

async fn upload_book(State(state): State<AppState>, headers: HeaderMap, mut multipart: Multipart) -> AppResult<Json<Book>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let mut field = multipart.next_field().await.map_err(|_| AppError::bad_request("上传数据无效"))?
        .ok_or_else(|| AppError::bad_request("请选择文件"))?;
    let original_name = field.file_name().unwrap_or("未命名").to_string();
    let extension = Path::new(&original_name).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if extension != "epub" && extension != "txt" { return Err(AppError::bad_request("只支持 EPUB 和 TXT 文件")); }

    // TXT 落盘时用 zstd 压缩，文件名带 .zst 后缀作为标记（下载时据此解压）；EPUB 本身已是 zip 不再压。
    let stored_name = if extension == "txt" {
        format!("{}.txt.zst", Uuid::new_v4())
    } else {
        format!("{}.{}", Uuid::new_v4(), extension)
    };
    let path = state.books_dir.join(&stored_name);
    let temp_path = state.books_dir.join(format!(".{}.tmp", Uuid::new_v4()));

    // 流式把上传内容写进临时文件：每次只持有一个分片，边写边卡 64MB 上限，避免整本书堆在内存里。
    let mut total: usize = 0;
    let mut head: Vec<u8> = Vec::with_capacity(2); // 只缓存头两字节，用于 EPUB 的 "PK" 校验
    let stream_result: AppResult<()> = async {
        let mut file = fs::File::create(&temp_path).await.map_err(|_| AppError::internal("保存书籍失败"))?;
        while let Some(chunk) = field.chunk().await.map_err(|_| AppError::bad_request("无法读取上传文件"))? {
            total += chunk.len();
            if total > MAX_BOOK_SIZE { return Err(AppError::bad_request("文件应在 1 字节到 64 MB 之间")); }
            for &byte in chunk.iter() {
                if head.len() >= 2 { break; }
                head.push(byte);
            }
            file.write_all(&chunk).await.map_err(|_| AppError::internal("保存书籍失败"))?;
        }
        file.flush().await.map_err(|_| AppError::internal("保存书籍失败"))?;
        Ok(())
    }.await;
    if let Err(error) = stream_result {
        let _ = fs::remove_file(&temp_path).await;
        return Err(error);
    }
    if total == 0 {
        let _ = fs::remove_file(&temp_path).await;
        return Err(AppError::bad_request("文件应在 1 字节到 64 MB 之间"));
    }
    if extension == "epub" && !head.starts_with(b"PK") {
        let _ = fs::remove_file(&temp_path).await;
        return Err(AppError::bad_request("EPUB 文件格式无效"));
    }
    // TXT：流式判定编码，必要时按 GBK 增量转码为 UTF-8，全程固定缓冲，内存与文件大小无关。
    // size 记录的是“逻辑大小”（解压后的 UTF-8 字节数），下载时用作 Content-Length。
    let size = if extension == "txt" {
        let size = match normalize_txt_to_utf8(&temp_path).await {
            Ok(size) => size,
            Err(error) => {
                let _ = fs::remove_file(&temp_path).await;
                return Err(error);
            }
        };
        if let Err(error) = compress_file_zstd(&temp_path, &path).await {
            let _ = fs::remove_file(&temp_path).await;
            let _ = fs::remove_file(&path).await;
            return Err(error);
        }
        let _ = fs::remove_file(&temp_path).await;
        size
    } else {
        if let Err(error) = fs::rename(&temp_path, &path).await {
            let _ = fs::remove_file(&temp_path).await;
            return Err(AppError::internal(format!("保存书籍失败: {error}")));
        }
        total as i64
    };
    let title = Path::new(&original_name).file_stem().and_then(|value| value.to_str()).unwrap_or("未命名").trim().to_string();
    let created_at = now();
    let insert_result = {
        let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
        db.execute("INSERT INTO books(user_id, title, kind, stored_name, size, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)", params![user_id, title, extension, stored_name, size, created_at])
            .map(|_| Book {
                id: db.last_insert_rowid(),
                title,
                kind: extension,
                size,
                created_at,
                author: None,
                series_name: None,
                series_index: None,
                updated_at: created_at,
                reading_progress: None,
            })
    };
    let result = match insert_result {
        Ok(book) => book,
        Err(_) => {
            let _ = fs::remove_file(&path).await;
            return Err(AppError::internal("保存书籍记录失败"));
        }
    };
    Ok(Json(result))
}

async fn update_book(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<i64>,
    Json(input): Json<BookUpdate>,
) -> AppResult<Json<ApiMessage>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let title = input.title.map(|value| value.trim().to_string());
    if title.as_deref().is_some_and(str::is_empty) {
        return Err(AppError::bad_request("书名不能为空"));
    }
    if input.series_index.is_some_and(|value| !value.is_finite() || value < 0.0) {
        return Err(AppError::bad_request("系列序号无效"));
    }
    let author_present = input.author.is_some();
    let series_name_present = input.series_name.is_some();
    let author = input.author.and_then(normalize_optional_text);
    let series_name = input.series_name.and_then(normalize_optional_text);
    if title.as_deref().is_some_and(|value| value.chars().count() > 240)
        || author.as_deref().is_some_and(|value| value.chars().count() > 160)
        || series_name.as_deref().is_some_and(|value| value.chars().count() > 200)
    {
        return Err(AppError::bad_request("书籍信息过长"));
    }
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    let changed = db.execute(
        "UPDATE books SET
             title = COALESCE(?1, title),
             author = CASE WHEN ?2 THEN ?3 ELSE author END,
             series_name = CASE WHEN ?4 THEN ?5 ELSE series_name END,
             series_index = CASE WHEN ?6 THEN ?7 ELSE series_index END,
             updated_at = ?8
         WHERE id = ?9 AND user_id = ?10",
        params![
            title,
            author_present,
            author,
            series_name_present,
            series_name,
            input.series_index.is_some() || input.clear_series_index,
            input.series_index,
            now(),
            id,
            user_id,
        ],
    ).map_err(|_| AppError::internal("更新书籍失败"))?;
    if changed == 0 {
        return Err(AppError(StatusCode::NOT_FOUND, "书籍不存在".into()));
    }
    Ok(Json(ApiMessage { message: "已更新".into() }))
}

async fn book_file(State(state): State<AppState>, headers: HeaderMap, AxumPath(id): AxumPath<i64>) -> AppResult<Response> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let record = {
        let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
        db.query_row("SELECT stored_name, kind, size FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
            .optional().map_err(|_| AppError::internal("读取书籍失败"))?
    }.ok_or_else(|| AppError(StatusCode::NOT_FOUND, "书籍不存在".into()))?;
    let (stored_name, kind, logical_size) = record;
    // 流式回传：每次只用约 8KB 缓冲，避免把整本书读进内存（慢客户端会让大文件长时间占用内存）。
    let file = fs::File::open(state.books_dir.join(&stored_name)).await.map_err(|_| AppError(StatusCode::NOT_FOUND, "书籍文件不存在".into()))?;
    let content_type = if kind == "epub" { "application/epub+zip" } else { "text/plain; charset=utf-8" };
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "private, max-age=3600");
    let body = if stored_name.ends_with(".zst") {
        // 压缩存储的 TXT：边读边 zstd 解压回传；解压后长度就是入库时记录的 size。
        builder = builder.header(header::CONTENT_LENGTH, logical_size as u64);
        Body::from_stream(ReaderStream::new(ZstdDecoder::new(BufReader::new(file))))
    } else {
        // 未压缩（EPUB，或本次改动之前上传的旧 TXT）：直接流式回传。
        if let Ok(meta) = file.metadata().await {
            builder = builder.header(header::CONTENT_LENGTH, meta.len());
        }
        Body::from_stream(ReaderStream::new(file))
    };
    builder.body(body).map_err(|_| AppError::internal("创建响应失败"))
}

async fn delete_book(State(state): State<AppState>, headers: HeaderMap, AxumPath(id): AxumPath<i64>) -> AppResult<Json<ApiMessage>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let stored_name = {
        let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
        db.query_row("SELECT stored_name FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id], |row| row.get::<_, String>(0))
            .optional().map_err(|_| AppError::internal("删除书籍失败"))?
    }.ok_or_else(|| AppError(StatusCode::NOT_FOUND, "书籍不存在".into()))?;
    let _ = fs::remove_file(state.books_dir.join(stored_name)).await;
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    db.execute("DELETE FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id]).map_err(|_| AppError::internal("删除书籍失败"))?;
    Ok(Json(ApiMessage { message: "已删除".into() }))
}

async fn get_progress(State(state): State<AppState>, headers: HeaderMap, AxumPath(id): AxumPath<i64>) -> AppResult<Json<Progress>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    let owns_book = db.query_row("SELECT 1 FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id], |_| Ok(()))
        .optional().map_err(|_| AppError::internal("读取进度失败"))?.is_some();
    if !owns_book { return Err(AppError(StatusCode::NOT_FOUND, "书籍不存在".into())); }
    let progress = db.query_row(
        "SELECT page, total_pages FROM reading_progress WHERE user_id = ?1 AND book_id = ?2",
        params![user_id, id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)),
    ).optional().map_err(|_| AppError::internal("读取进度失败"))?.unwrap_or((0, None));
    Ok(Json(Progress { page: progress.0, total_pages: progress.1 }))
}

async fn save_progress(State(state): State<AppState>, headers: HeaderMap, AxumPath(id): AxumPath<i64>, Json(input): Json<ProgressInput>) -> AppResult<Json<Progress>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    if input.page < 0 || input.page > i32::MAX as i64 { return Err(AppError::bad_request("页码无效")); }
    if input.total_pages.is_some_and(|value| value < 1 || value > i32::MAX as i64) {
        return Err(AppError::bad_request("总页数无效"));
    }
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    let owns_book = db.query_row("SELECT 1 FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id], |_| Ok(()))
        .optional().map_err(|_| AppError::internal("保存进度失败"))?.is_some();
    if !owns_book { return Err(AppError(StatusCode::NOT_FOUND, "书籍不存在".into())); }
    db.execute(
        "INSERT INTO reading_progress(user_id, book_id, page, updated_at, total_pages) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, book_id) DO UPDATE SET
             page = excluded.page,
             updated_at = excluded.updated_at,
             total_pages = COALESCE(excluded.total_pages, reading_progress.total_pages)",
        params![user_id, id, input.page, now(), input.total_pages],
    ).map_err(|_| AppError::internal("保存进度失败"))?;
    Ok(Json(Progress { page: input.page, total_pages: input.total_pages }))
}

fn open_database(data_dir: &Path) -> Result<Connection, Box<dyn std::error::Error>> {
    let connection = Connection::open(data_dir.join("reader.db"))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS users (
             id INTEGER PRIMARY KEY,
             username TEXT NOT NULL UNIQUE,
             password_hash TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sessions (
             token_hash TEXT PRIMARY KEY,
             user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             expires_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS books (
             id INTEGER PRIMARY KEY,
             user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             title TEXT NOT NULL,
             kind TEXT NOT NULL,
             stored_name TEXT NOT NULL UNIQUE,
             size INTEGER NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS reading_progress (
             user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
             page INTEGER NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL,
             PRIMARY KEY(user_id, book_id)
         );
         CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
         CREATE INDEX IF NOT EXISTS books_user_id ON books(user_id);",
    )?;
    ensure_column(&connection, "books", "author", "TEXT")?;
    ensure_column(&connection, "books", "series_name", "TEXT")?;
    ensure_column(&connection, "books", "series_index", "REAL")?;
    ensure_column(&connection, "books", "updated_at", "INTEGER")?;
    ensure_column(&connection, "reading_progress", "total_pages", "INTEGER")?;
    Ok(connection)
}

// 交互式创建账号：`rust-reader create-admin`。没有公开注册，账号只用于防白嫖与爆破。
fn create_user_cli() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = PathBuf::from(std::env::var("READER_DATA_DIR").unwrap_or_else(|_| "data".into()));
    std::fs::create_dir_all(data_dir.join("books"))?;
    let connection = open_database(&data_dir)?;

    let username = prompt("用户名 (3-32 位): ")?;
    let username = username.trim();
    let name_length = username.chars().count();
    if !(3..=32).contains(&name_length) {
        return Err("用户名长度需为 3 到 32 位".into());
    }

    let password = prompt("密码 (8-128 位): ")?;
    let confirm = prompt("确认密码: ")?;
    if password != confirm {
        return Err("两次输入的密码不一致".into());
    }
    let password_length = password.chars().count();
    if !(8..=128).contains(&password_length) {
        return Err("密码长度需为 8 到 128 位".into());
    }

    let salt_seed = Uuid::new_v4();
    let salt = SaltString::encode_b64(salt_seed.as_bytes()).map_err(|error| format!("生成密码盐失败: {error}"))?;
    let hash = Argon2::default().hash_password(password.as_bytes(), &salt).map_err(|error| format!("密码哈希失败: {error}"))?.to_string();

    connection
        .execute("INSERT INTO users(username, password_hash, created_at) VALUES(?1, ?2, ?3)", params![username, hash, now()])
        .map_err(|error| format!("创建用户失败（用户名可能已存在）: {error}"))?;
    println!("已创建用户：{username}");
    Ok(())
}

fn prompt(label: &str) -> std::io::Result<String> {
    use std::io::Write;
    print!("{label}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}

fn ensure_column(connection: &Connection, table: &str, column: &str, definition: &str) -> rusqlite::Result<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    drop(statement);
    connection.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
    Ok(())
}

fn normalize_optional_text(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

// 把 TXT 临时文件规范化为 UTF-8，返回最终字节数。本来就是 UTF-8 则原样保留，否则按 GBK 增量转码。
// 全程固定缓冲，内存与文件大小无关（取代了旧的“整篇读进内存判断/解码”）。
async fn normalize_txt_to_utf8(temp_path: &Path) -> AppResult<i64> {
    if is_file_valid_utf8(temp_path).await? {
        let meta = fs::metadata(temp_path).await.map_err(|_| AppError::internal("保存书籍失败"))?;
        return Ok(meta.len() as i64);
    }
    let converted = temp_path.with_extension("gbk-utf8.tmp");
    match decode_gbk_to_utf8_file(temp_path, &converted).await {
        Ok(size) => {
            fs::rename(&converted, temp_path).await.map_err(|_| AppError::internal("保存书籍失败"))?;
            Ok(size)
        }
        Err(error) => {
            let _ = fs::remove_file(&converted).await;
            Err(error)
        }
    }
}

// 分块读文件做 UTF-8 校验，跨缓冲边界的不完整多字节序列用 carry 暂存（最多 3 字节）；只占固定缓冲。
async fn is_file_valid_utf8(path: &Path) -> AppResult<bool> {
    let mut file = fs::File::open(path).await.map_err(|_| AppError::internal("保存书籍失败"))?;
    let mut buffer = vec![0u8; 64 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    loop {
        let read = file.read(&mut buffer).await.map_err(|_| AppError::internal("保存书籍失败"))?;
        if read == 0 {
            break;
        }
        let mut data = std::mem::take(&mut carry);
        data.extend_from_slice(&buffer[..read]);
        if let Err(error) = std::str::from_utf8(&data) {
            // error_len 有值＝真正的非法序列；为 None＝末尾被截断的不完整字符，留到下一块再拼。
            if error.error_len().is_some() {
                return Ok(false);
            }
            carry.extend_from_slice(&data[error.valid_up_to()..]);
        }
    }
    // EOF 仍有残留＝末尾是被截断的多字节序列，按非 UTF-8 处理。
    Ok(carry.is_empty())
}

// 流式 GBK -> UTF-8 解码写到目标文件，返回写出的 UTF-8 字节数；固定缓冲。
async fn decode_gbk_to_utf8_file(src: &Path, dst: &Path) -> AppResult<i64> {
    let mut input = fs::File::open(src).await.map_err(|_| AppError::internal("保存书籍失败"))?;
    let mut output = fs::File::create(dst).await.map_err(|_| AppError::internal("保存书籍失败"))?;
    let mut decoder = encoding_rs::GBK.new_decoder();
    let mut in_buf = vec![0u8; 64 * 1024];
    let mut out_buf = vec![0u8; 96 * 1024]; // 双字节汉字最坏膨胀到 3 字节，1.5x 足够；不足由 OutputFull 循环兜底
    let mut total: i64 = 0;
    loop {
        let read = input.read(&mut in_buf).await.map_err(|_| AppError::internal("保存书籍失败"))?;
        let last = read == 0;
        let mut offset = 0;
        loop {
            let (result, consumed, produced, _) = decoder.decode_to_utf8(&in_buf[offset..read], &mut out_buf, last);
            if produced > 0 {
                output.write_all(&out_buf[..produced]).await.map_err(|_| AppError::internal("保存书籍失败"))?;
                total += produced as i64;
            }
            offset += consumed;
            match result {
                encoding_rs::CoderResult::InputEmpty => break,
                encoding_rs::CoderResult::OutputFull => continue,
            }
        }
        if last {
            break;
        }
    }
    output.flush().await.map_err(|_| AppError::internal("保存书籍失败"))?;
    Ok(total)
}

// 流式 zstd 压缩 src -> dst（用于 TXT 落盘）。中文纯文本通常能压到 1/3~1/5；固定缓冲，内存与文件大小无关。
async fn compress_file_zstd(src: &Path, dst: &Path) -> AppResult<()> {
    let input = BufReader::new(fs::File::open(src).await.map_err(|_| AppError::internal("保存书籍失败"))?);
    let mut encoder = ZstdEncoder::with_quality(input, Level::Precise(19));
    let mut output = fs::File::create(dst).await.map_err(|_| AppError::internal("保存书籍失败"))?;
    tokio::io::copy(&mut encoder, &mut output).await.map_err(|_| AppError::internal("保存书籍失败"))?;
    output.flush().await.map_err(|_| AppError::internal("保存书籍失败"))?;
    Ok(())
}

async fn session_response(state: &AppState, user_id: i64, message: &str, secure: bool) -> AppResult<Response> {
    let token = Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string();
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    db.execute("DELETE FROM sessions WHERE expires_at < ?1", [now()]).map_err(|_| AppError::internal("会话清理失败"))?;
    db.execute("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?1, ?2, ?3)", params![hash_token(&token), user_id, now() + SESSION_SECONDS])
        .map_err(|_| AppError::internal("创建会话失败"))?;
    drop(db);
    let cookie = build_session_cookie(&token, SESSION_SECONDS, secure);
    let mut response = Json(ApiMessage { message: message.into() }).into_response();
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).map_err(|_| AppError::internal("创建会话失败"))?);
    Ok(response)
}

fn build_session_cookie(token: &str, max_age: i64, secure: bool) -> String {
    let mut cookie = format!("reader_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

// 优先取反代透传的真实来源，其次回退到 TCP 连接地址。
fn client_ip(headers: &HeaderMap, addr: Option<SocketAddr>) -> String {
    if let Some(forwarded) = headers.get("x-forwarded-for").and_then(|value| value.to_str().ok()) {
        let first = forwarded.split(',').next().unwrap_or("").trim();
        if !first.is_empty() {
            return first.to_string();
        }
    }
    if let Some(real) = headers.get("x-real-ip").and_then(|value| value.to_str().ok()) {
        let real = real.trim();
        if !real.is_empty() {
            return real.to_string();
        }
    }
    addr.map(|value| value.ip().to_string()).unwrap_or_else(|| "unknown".into())
}

fn cookie_secure(state: &AppState, headers: &HeaderMap) -> bool {
    if state.force_secure_cookie {
        return true;
    }
    headers.get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.split(',').next().unwrap_or("").trim().eq_ignore_ascii_case("https"))
}

fn rate_limit_check(state: &AppState, key: &str) -> AppResult<()> {
    let now = now();
    let mut attempts = state.login_attempts.lock().unwrap();
    attempts.retain(|_, attempt| attempt.reset_at > now);
    // 跟踪表已满且是新 key：不再新增（防伪造来源灌爆内存）。并发哈希另由 hash_limit 信号量兜底，这里放行不影响内存安全。
    if attempts.len() >= LOGIN_MAX_TRACKED_IPS && !attempts.contains_key(key) {
        return Ok(());
    }
    let entry = attempts.entry(key.to_string()).or_insert(LoginAttempt { count: 0, reset_at: now + LOGIN_WINDOW_SECONDS });
    if entry.count >= LOGIN_MAX_ATTEMPTS {
        return Err(AppError(StatusCode::TOO_MANY_REQUESTS, "登录尝试过于频繁，请稍后再试".into()));
    }
    entry.count += 1;
    Ok(())
}

fn rate_limit_reset(state: &AppState, key: &str) {
    state.login_attempts.lock().unwrap().remove(key);
}

async fn authenticated_user(state: &AppState, headers: &HeaderMap) -> AppResult<(i64, String)> {
    let token = cookie_value(headers, "reader_session").ok_or_else(AppError::unauthorized)?;
    let db = state.db.get().map_err(|_| AppError::internal("数据库繁忙"))?;
    db.query_row(
        "SELECT users.id, users.username FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?1 AND sessions.expires_at > ?2",
        params![hash_token(&token), now()], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|_| AppError::internal("读取会话失败"))?.ok_or_else(AppError::unauthorized)
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(header::COOKIE)?.to_str().ok()?.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name).then(|| value.to_string())
    })
}

fn hash_token(token: &str) -> String { hex::encode(Sha256::digest(token.as_bytes())) }
fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64 }
