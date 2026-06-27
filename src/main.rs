use std::{path::{Path, PathBuf}, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

use argon2::{Argon2, password_hash::{PasswordHash, PasswordVerifier}};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{fs, net::TcpListener, sync::Mutex};
use uuid::Uuid;

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

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    books_dir: Arc<PathBuf>,
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
    if let Err(error) = run().await {
        eprintln!("启动失败: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = std::env::var("READER_DATA_DIR").unwrap_or_else(|_| "data".into());
    let data_dir = PathBuf::from(data_dir);
    let books_dir = data_dir.join("books");
    fs::create_dir_all(&books_dir).await?;

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
         CREATE INDEX IF NOT EXISTS books_user_id ON books(user_id);"
    )?;
    ensure_column(&connection, "books", "author", "TEXT")?;
    ensure_column(&connection, "books", "series_name", "TEXT")?;
    ensure_column(&connection, "books", "series_index", "REAL")?;
    ensure_column(&connection, "books", "updated_at", "INTEGER")?;
    ensure_column(&connection, "reading_progress", "total_pages", "INTEGER")?;

    let state = AppState { db: Arc::new(Mutex::new(connection)), books_dir: Arc::new(books_dir) };
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
        .route("/api/books", get(list_books).post(upload_book))
        .route("/api/books/{id}", delete(delete_book).patch(update_book))
        .route("/api/books/{id}/file", get(book_file))
        .route("/api/books/{id}/progress", get(get_progress).put(save_progress))
        .fallback(spa_fallback)
        .layer(DefaultBodyLimit::max(MAX_BOOK_SIZE + 1024 * 1024))
        .with_state(state);

    let address = std::env::var("READER_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".into());
    let listener = TcpListener::bind(&address).await?;
    println!("Rust Reader: http://{address}");
    axum::serve(listener, app).await?;
    Ok(())
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

async fn login(State(state): State<AppState>, Json(input): Json<AuthInput>) -> AppResult<Response> {
    let record = {
        let db = state.db.lock().await;
        db.query_row("SELECT id, password_hash FROM users WHERE username = ?1", [input.username.trim()], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .optional().map_err(|_| AppError::internal("登录失败"))?
    };
    let Some((user_id, stored_hash)) = record else { return Err(AppError::bad_request("用户名或密码错误")); };
    let parsed = PasswordHash::new(&stored_hash).map_err(|_| AppError::internal("账户密码数据无效"))?;
    if Argon2::default().verify_password(input.password.as_bytes(), &parsed).is_err() {
        return Err(AppError::bad_request("用户名或密码错误"));
    }
    session_response(&state, user_id, "登录成功").await
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    if let Some(token) = cookie_value(&headers, "reader_session") {
        let db = state.db.lock().await;
        db.execute("DELETE FROM sessions WHERE token_hash = ?1", [hash_token(&token)])
            .map_err(|_| AppError::internal("退出失败"))?;
    }
    let mut response = Json(ApiMessage { message: "已退出".into() }).into_response();
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_static("reader_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"));
    Ok(response)
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Me>> {
    let (id, username) = authenticated_user(&state, &headers).await?;
    Ok(Json(Me { id, username }))
}

async fn list_books(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Json<Vec<Book>>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let db = state.db.lock().await;
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
    let field = multipart.next_field().await.map_err(|_| AppError::bad_request("上传数据无效"))?
        .ok_or_else(|| AppError::bad_request("请选择文件"))?;
    let original_name = field.file_name().unwrap_or("未命名").to_string();
    let extension = Path::new(&original_name).extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if extension != "epub" && extension != "txt" { return Err(AppError::bad_request("只支持 EPUB 和 TXT 文件")); }
    let mut data = field.bytes().await.map_err(|_| AppError::bad_request("无法读取上传文件"))?.to_vec();
    if data.is_empty() || data.len() > MAX_BOOK_SIZE { return Err(AppError::bad_request("文件应在 1 字节到 64 MB 之间")); }
    if extension == "epub" && !data.starts_with(b"PK") { return Err(AppError::bad_request("EPUB 文件格式无效")); }
    if extension == "txt" && std::str::from_utf8(&data).is_err() {
        let (decoded, _, _) = encoding_rs::GBK.decode(&data);
        data = decoded.into_owned().into_bytes();
    }

    let stored_name = format!("{}.{}", Uuid::new_v4(), extension);
    let path = state.books_dir.join(&stored_name);
    fs::write(&path, &data).await.map_err(|_| AppError::internal("保存书籍失败"))?;
    let title = Path::new(&original_name).file_stem().and_then(|value| value.to_str()).unwrap_or("未命名").trim().to_string();
    let created_at = now();
    let insert_result = {
        let db = state.db.lock().await;
        db.execute("INSERT INTO books(user_id, title, kind, stored_name, size, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)", params![user_id, title, extension, stored_name, data.len() as i64, created_at])
            .map(|_| Book {
                id: db.last_insert_rowid(),
                title,
                kind: extension,
                size: data.len() as i64,
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
    let db = state.db.lock().await;
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
        let db = state.db.lock().await;
        db.query_row("SELECT stored_name, kind FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .optional().map_err(|_| AppError::internal("读取书籍失败"))?
    }.ok_or_else(|| AppError(StatusCode::NOT_FOUND, "书籍不存在".into()))?;
    let data = fs::read(state.books_dir.join(record.0)).await.map_err(|_| AppError(StatusCode::NOT_FOUND, "书籍文件不存在".into()))?;
    let content_type = if record.1 == "epub" { "application/epub+zip" } else { "text/plain; charset=utf-8" };
    Response::builder().header(header::CONTENT_TYPE, content_type).header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(data)).map_err(|_| AppError::internal("创建响应失败"))
}

async fn delete_book(State(state): State<AppState>, headers: HeaderMap, AxumPath(id): AxumPath<i64>) -> AppResult<Json<ApiMessage>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let stored_name = {
        let db = state.db.lock().await;
        db.query_row("SELECT stored_name FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id], |row| row.get::<_, String>(0))
            .optional().map_err(|_| AppError::internal("删除书籍失败"))?
    }.ok_or_else(|| AppError(StatusCode::NOT_FOUND, "书籍不存在".into()))?;
    let _ = fs::remove_file(state.books_dir.join(stored_name)).await;
    let db = state.db.lock().await;
    db.execute("DELETE FROM books WHERE id = ?1 AND user_id = ?2", params![id, user_id]).map_err(|_| AppError::internal("删除书籍失败"))?;
    Ok(Json(ApiMessage { message: "已删除".into() }))
}

async fn get_progress(State(state): State<AppState>, headers: HeaderMap, AxumPath(id): AxumPath<i64>) -> AppResult<Json<Progress>> {
    let (user_id, _) = authenticated_user(&state, &headers).await?;
    let db = state.db.lock().await;
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
    let db = state.db.lock().await;
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

async fn session_response(state: &AppState, user_id: i64, message: &str) -> AppResult<Response> {
    let token = Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string();
    let db = state.db.lock().await;
    db.execute("DELETE FROM sessions WHERE expires_at < ?1", [now()]).map_err(|_| AppError::internal("会话清理失败"))?;
    db.execute("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?1, ?2, ?3)", params![hash_token(&token), user_id, now() + SESSION_SECONDS])
        .map_err(|_| AppError::internal("创建会话失败"))?;
    drop(db);
    let cookie = format!("reader_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECONDS}");
    let mut response = Json(ApiMessage { message: message.into() }).into_response();
    response.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).map_err(|_| AppError::internal("创建会话失败"))?);
    Ok(response)
}

async fn authenticated_user(state: &AppState, headers: &HeaderMap) -> AppResult<(i64, String)> {
    let token = cookie_value(headers, "reader_session").ok_or_else(AppError::unauthorized)?;
    let db = state.db.lock().await;
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
