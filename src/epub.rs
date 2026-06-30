// 服务端 EPUB 解析：解 zip / OPF / spine、抽取目录（nav + NCX）、清洗章节正文、
// 图片落盘到 derived/assets、抽封面与作者/系列元数据。
//
// 设计：正文 HTML 用“白名单式 emit”生成——只输出允许的标签/属性，脚本/事件处理器/危险协议
// 按构造永不出现，等价于旧前端 sanitizeDocument 的安全模型，但无需对 DOM 做易错的就地变更。
// 产物（content.html / cover.* / assets/*）供 /api/books/:id/content 与 /asset 直接分发。

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use percent_encoding::percent_decode_str;
use regex::Regex;
use scraper::ego_tree::NodeRef;
use scraper::node::Element;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;
use zip::ZipArchive;

pub struct ParsedEpub {
    pub author: Option<String>,
    pub series_name: Option<String>,
    pub series_index: Option<f64>,
    pub toc_json: String,
    pub cover_ext: Option<String>,
}

#[derive(Serialize)]
struct EpubTocEntry {
    label: String,
    path: String,
    fragment: String,
    depth: u32,
}

#[derive(Serialize)]
struct TxtTocEntry {
    label: String,
    offset: usize,
    depth: u32,
}

struct ManifestItem {
    path: String,
    media_type: String,
    properties: String,
}

struct Package {
    manifest: HashMap<String, ManifestItem>,
    spine: Vec<String>,
    ncx_id: Option<String>,
    author: Option<String>,
    series_name: Option<String>,
    series_index: Option<f64>,
    cover: Option<ManifestItem>,
}

struct AssetRec {
    idx: usize,
    dims: Option<(u32, u32)>,
}

struct RenderCtx<'a> {
    book_id: i64,
    chapter_path: String,
    zip: &'a mut ZipArchive<File>,
    assets_dir: &'a Path,
    assets: &'a mut HashMap<String, AssetRec>,
    out: &'a mut String,
    pending_ids: Vec<String>,
}

// ---- 入口 ----

pub fn parse_epub(epub_path: &Path, derived_dir: &Path, book_id: i64) -> Result<ParsedEpub, String> {
    let file = File::open(epub_path).map_err(|e| format!("打开 EPUB 失败: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("EPUB 不是有效的 zip: {e}"))?;

    let container = zip_text(&mut zip, "META-INF/container.xml")?;
    let opf_path = opf_path_from_container(&container)?;
    let opf_xml = zip_text(&mut zip, &opf_path)?;
    let pkg = parse_opf(&opf_xml, &opf_path)?;

    fs::create_dir_all(derived_dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let assets_dir = derived_dir.join("assets");

    let cover_ext = pkg
        .cover
        .as_ref()
        .and_then(|cover| extract_cover(&mut zip, cover, derived_dir));

    let toc = extract_toc(&mut zip, &opf_xml, &pkg)?;
    let toc_json = serde_json::to_string(&toc).map_err(|e| format!("序列化目录失败: {e}"))?;

    let mut assets: HashMap<String, AssetRec> = HashMap::new();
    let mut html_out = String::new();
    for idref in &pkg.spine {
        let Some(item) = pkg.manifest.get(idref) else { continue };
        if !is_html_media(&item.media_type) {
            continue;
        }
        let Ok(chapter) = zip_text(&mut zip, &item.path) else { continue };
        let mut ctx = RenderCtx {
            book_id,
            chapter_path: item.path.clone(),
            zip: &mut zip,
            assets_dir: &assets_dir,
            assets: &mut assets,
            out: &mut html_out,
            pending_ids: Vec::new(),
        };
        render_chapter(&chapter, &mut ctx);
    }
    if html_out.trim().is_empty() {
        return Err("EPUB 中没有可阅读内容".into());
    }
    fs::write(derived_dir.join("content.html"), html_out.as_bytes())
        .map_err(|e| format!("写入正文失败: {e}"))?;

    Ok(ParsedEpub {
        author: pkg.author,
        series_name: pkg.series_name,
        series_index: pkg.series_index,
        toc_json,
        cover_ext,
    })
}

// TXT 目录：偏移量按 UTF-16 码元计（与前端 text.slice 语义一致）。返回 JSON 数组字符串。
pub fn extract_txt_toc(text: &str) -> String {
    let re = match Regex::new(
        r"(?im)^[ \t\x{3000}]{0,4}(第[零〇一二三四五六七八九十百千万两\d]+[章节卷部回篇][^\n]{0,40}|(?:chapter|part)\s+[ivxlcdm\d]+[^\n]{0,40})\s*$",
    ) {
        Ok(re) => re,
        Err(_) => return "[]".into(),
    };
    let mut marks: Vec<(usize, String)> = Vec::new();
    for caps in re.captures_iter(text) {
        if marks.len() >= 500 {
            break;
        }
        let start = caps.get(0).map(|m| m.start()).unwrap_or(0);
        let label = caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        marks.push((start, label));
    }
    let mut entries: Vec<TxtTocEntry> = Vec::with_capacity(marks.len());
    let mut mi = 0;
    let mut utf16 = 0usize;
    for (bi, ch) in text.char_indices() {
        while mi < marks.len() && marks[mi].0 == bi {
            entries.push(TxtTocEntry { label: marks[mi].1.clone(), offset: utf16, depth: 0 });
            mi += 1;
        }
        utf16 += ch.len_utf16();
    }
    while mi < marks.len() {
        entries.push(TxtTocEntry { label: marks[mi].1.clone(), offset: utf16, depth: 0 });
        mi += 1;
    }
    serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into())
}

pub fn asset_content_type(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

// ---- OPF / 容器 ----

fn opf_path_from_container(xml: &str) -> Result<String, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|_| "container.xml 解析失败".to_string())?;
    let rootfile = doc
        .descendants()
        .find(|n| n.has_tag_name("rootfile") || n.tag_name().name() == "rootfile")
        .ok_or("EPUB 缺少 container rootfile")?;
    let full = rootfile
        .attribute("full-path")
        .ok_or("EPUB rootfile 缺少 full-path")?;
    Ok(normalize_path(full))
}

fn parse_opf(xml: &str, opf_path: &str) -> Result<Package, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|_| "OPF 解析失败".to_string())?;

    let mut manifest: HashMap<String, ManifestItem> = HashMap::new();
    for node in doc.descendants().filter(|n| n.tag_name().name() == "item") {
        let (Some(id), Some(href)) = (node.attribute("id"), node.attribute("href")) else {
            continue;
        };
        manifest.insert(
            id.to_string(),
            ManifestItem {
                path: resolve_path(opf_path, href),
                media_type: node.attribute("media-type").unwrap_or("").to_string(),
                properties: node.attribute("properties").unwrap_or("").to_string(),
            },
        );
    }

    let spine_node = doc.descendants().find(|n| n.tag_name().name() == "spine");
    let ncx_id = spine_node
        .and_then(|n| n.attribute("toc"))
        .map(|s| s.to_string());
    let spine: Vec<String> = doc
        .descendants()
        .filter(|n| n.tag_name().name() == "itemref")
        .filter_map(|n| n.attribute("idref").map(|s| s.to_string()))
        .collect();

    let author = doc
        .descendants()
        .find(|n| n.tag_name().name() == "creator")
        .and_then(|n| n.text())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let (series_name, series_index) = extract_series(&doc);
    let cover = extract_cover_item(&doc, &manifest);

    Ok(Package { manifest, spine, ncx_id, author, series_name, series_index, cover })
}

fn extract_series(doc: &roxmltree::Document) -> (Option<String>, Option<f64>) {
    let mut name: Option<String> = None;
    let mut index: Option<f64> = None;
    // Calibre 风格：<meta name="calibre:series" content="...">
    for meta in doc.descendants().filter(|n| n.tag_name().name() == "meta") {
        match meta.attribute("name") {
            Some("calibre:series") => {
                name = meta.attribute("content").map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            }
            Some("calibre:series_index") => {
                index = meta.attribute("content").and_then(|s| s.trim().parse::<f64>().ok());
            }
            _ => {}
        }
    }
    // EPUB3 风格：<meta property="belongs-to-collection" id="c1">名称</meta> + group-position。
    if name.is_none() {
        for meta in doc.descendants().filter(|n| n.tag_name().name() == "meta") {
            if meta.attribute("property") == Some("belongs-to-collection") {
                if let Some(text) = meta.text() {
                    let text = text.trim();
                    if !text.is_empty() {
                        name = Some(text.to_string());
                    }
                }
            }
            if meta.attribute("property") == Some("group-position") {
                index = meta.text().and_then(|s| s.trim().parse::<f64>().ok());
            }
        }
    }
    (name, index)
}

fn extract_cover_item(doc: &roxmltree::Document, manifest: &HashMap<String, ManifestItem>) -> Option<ManifestItem> {
    let clone = |item: &ManifestItem| ManifestItem {
        path: item.path.clone(),
        media_type: item.media_type.clone(),
        properties: item.properties.clone(),
    };
    // 1) <meta name="cover" content="<id>">
    if let Some(id) = doc
        .descendants()
        .find(|n| n.tag_name().name() == "meta" && n.attribute("name") == Some("cover"))
        .and_then(|n| n.attribute("content"))
    {
        if let Some(item) = manifest.get(id) {
            return Some(clone(item));
        }
    }
    // 2) manifest item properties 含 cover-image
    if let Some(item) = manifest
        .values()
        .find(|item| item.properties.split_whitespace().any(|p| p == "cover-image"))
    {
        return Some(clone(item));
    }
    // 3) 文件名启发式：路径含 cover 且是图片
    let re = Regex::new(r"(?i)(^|[/_.\-])cover([/_.\-]|$)").ok()?;
    manifest
        .values()
        .find(|item| item.media_type.starts_with("image/") && re.is_match(&item.path))
        .map(clone)
}

fn extract_cover(zip: &mut ZipArchive<File>, cover: &ManifestItem, derived_dir: &Path) -> Option<String> {
    let bytes = read_zip_bytes(zip, &cover.path)?;
    let ext = ext_of(&cover.path);
    fs::write(derived_dir.join(format!("cover.{ext}")), &bytes).ok()?;
    Some(ext)
}

// ---- 目录（nav 优先，回退 NCX） ----

fn extract_toc(zip: &mut ZipArchive<File>, _opf_xml: &str, pkg: &Package) -> Result<Vec<EpubTocEntry>, String> {
    // EPUB3 nav 文档：manifest properties 含 nav。
    if let Some(nav_item) = pkg.manifest.values().find(|item| {
        item.properties.split_whitespace().any(|p| p == "nav")
    }) {
        if let Ok(nav_html) = zip_text(zip, &nav_item.path) {
            let entries = parse_nav(&nav_html, &nav_item.path);
            if !entries.is_empty() {
                return Ok(entries);
            }
        }
    }
    // 回退 NCX：spine 的 toc 属性指向的 item，或任意 media-type 含 ncx 的 item。
    let ncx_item = pkg
        .ncx_id
        .as_ref()
        .and_then(|id| pkg.manifest.get(id))
        .or_else(|| pkg.manifest.values().find(|item| item.media_type.to_lowercase().contains("ncx")));
    let Some(ncx_item) = ncx_item else {
        return Ok(Vec::new());
    };
    let Ok(ncx_xml) = zip_text(zip, &ncx_item.path) else {
        return Ok(Vec::new());
    };
    Ok(parse_ncx(&ncx_xml, &ncx_item.path))
}

fn parse_nav(nav_html: &str, nav_path: &str) -> Vec<EpubTocEntry> {
    let doc = Html::parse_document(nav_html);
    let nav_sel = Selector::parse("nav").unwrap();
    let navs: Vec<ElementRef> = doc.select(&nav_sel).collect();
    if navs.is_empty() {
        return Vec::new();
    }
    // 优先含 epub:type="toc"/type="toc" 的 nav（scraper 把 epub:type 归一为 type）。
    let nav = navs
        .iter()
        .find(|n| n.value().attrs().any(|(_, v)| v == "toc"))
        .copied()
        .unwrap_or(navs[0]);

    let a_sel = Selector::parse("a[href]").unwrap();
    let mut entries = Vec::new();
    for anchor in nav.select(&a_sel) {
        let href = anchor.value().attr("href").unwrap_or("");
        let label = anchor.text().collect::<String>().trim().to_string();
        if label.is_empty() {
            continue;
        }
        entries.push(EpubTocEntry {
            label,
            path: resolve_path(nav_path, href),
            fragment: fragment_of(href),
            depth: list_depth(*anchor),
        });
    }
    entries
}

fn parse_ncx(ncx_xml: &str, ncx_path: &str) -> Vec<EpubTocEntry> {
    let Ok(doc) = roxmltree::Document::parse(ncx_xml) else {
        return Vec::new();
    };
    doc.descendants()
        .filter(|n| n.tag_name().name() == "navPoint")
        .map(|point| {
            let label = point
                .descendants()
                .find(|n| n.tag_name().name() == "text")
                .and_then(|n| n.text())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "未命名章节".to_string());
            let src = point
                .descendants()
                .find(|n| n.tag_name().name() == "content")
                .and_then(|n| n.attribute("src"))
                .unwrap_or("");
            EpubTocEntry {
                label,
                path: resolve_path(ncx_path, src),
                fragment: fragment_of(src),
                depth: ncx_depth(point),
            }
        })
        .collect()
}

fn list_depth(anchor: NodeRef<Node>) -> u32 {
    let mut depth = 0u32;
    for node in anchor.ancestors() {
        if let Some(el) = node.value().as_element() {
            let name = el.name();
            if name == "ol" || name == "ul" {
                depth += 1;
            }
        }
    }
    depth.saturating_sub(1)
}

fn ncx_depth(point: roxmltree::Node) -> u32 {
    let mut depth = 0u32;
    let mut parent = point.parent();
    while let Some(node) = parent {
        if node.tag_name().name() == "navPoint" {
            depth += 1;
        }
        parent = node.parent();
    }
    depth
}

// ---- 章节渲染 ----

fn render_chapter(chapter_html: &str, ctx: &mut RenderCtx) {
    let doc = Html::parse_document(chapter_html);
    let body_sel = Selector::parse("body").unwrap();
    let Some(body) = doc.select(&body_sel).next() else {
        return;
    };
    ctx.pending_ids.clear();
    walk(*body, ctx);
}

// 端口自旧前端 collectReadableBlocks：把嵌套正文摊平成块序列，丢空段、转裸文本为 <p>、
// 把锚点 id 顺延到下一个可读块（data-frag-ids），每块标注 data-source-path 供目录定位。
fn walk(parent: NodeRef<Node>, ctx: &mut RenderCtx) {
    for child in parent.children() {
        match child.value() {
            Node::Text(text) => {
                let s = &text[..];
                if !s.trim().is_empty() {
                    let extra = block_extra(ctx);
                    ctx.out.push_str("<p");
                    ctx.out.push_str(&extra);
                    ctx.out.push('>');
                    ctx.out.push_str(&escape_text(s));
                    ctx.out.push_str("</p>");
                }
            }
            Node::Element(el) => {
                let tag = el.name().to_ascii_lowercase();
                if is_disallowed(&tag) {
                    continue;
                }
                let child_id = el.attr("id").map(|s| s.to_string());
                if is_block_tag(&tag) {
                    let keep = tag == "hr"
                        || tag == "img"
                        || tag == "svg"
                        || !elem_text(child).trim().is_empty()
                        || has_media(child, true);
                    if keep {
                        let extra = block_extra(ctx);
                        emit_element(child, ctx, &extra);
                    } else if let Some(id) = child_id {
                        ctx.pending_ids.push(id);
                    }
                } else if has_block_descendant(child) {
                    if let Some(id) = child_id {
                        ctx.pending_ids.push(id);
                    }
                    walk(child, ctx);
                } else if !elem_text(child).trim().is_empty() || has_media(child, false) {
                    let extra = block_extra(ctx);
                    emit_element(child, ctx, &extra);
                } else if let Some(id) = child_id {
                    ctx.pending_ids.push(id);
                }
            }
            _ => {}
        }
    }
}

// 取出当前块要注入的属性串：data-source-path 必有；若有顺延的锚点 id 则加 data-frag-ids。
fn block_extra(ctx: &mut RenderCtx) -> String {
    let mut extra = format!(" data-source-path=\"{}\"", escape_attr(&ctx.chapter_path));
    if !ctx.pending_ids.is_empty() {
        extra.push_str(&format!(" data-frag-ids=\"{}\"", escape_attr(&ctx.pending_ids.join(" "))));
        ctx.pending_ids.clear();
    }
    extra
}

// 白名单 emit：只输出允许的标签/属性。extra 只注入到当前（块根）标签上。
fn emit_element(node: NodeRef<Node>, ctx: &mut RenderCtx, extra: &str) {
    let Some(el) = node.value().as_element() else { return };
    let tag = el.name().to_ascii_lowercase();
    if is_disallowed(&tag) {
        return;
    }
    if tag == "svg" {
        if let Some(html) = svg_single_image(node, ctx, extra) {
            ctx.out.push_str(&html);
            return;
        }
    }
    if tag == "img" {
        emit_img(el, ctx, extra);
        return;
    }
    if tag == "image" {
        if let Some(href) = attr_local(el, "href") {
            if let Some(html) = build_img(href, None, ctx, extra) {
                ctx.out.push_str(&html);
            }
        }
        return;
    }

    ctx.out.push('<');
    ctx.out.push_str(&tag);
    for (name, value) in el.attrs() {
        let lname = name.to_ascii_lowercase();
        if lname == "style" || lname == "align" || lname.starts_with("on") {
            continue;
        }
        if lname == "src" || lname == "srcset" {
            continue;
        }
        if lname == "href" || lname.ends_with(":href") {
            if let Some(clean) = sanitize_href(value) {
                push_attr(ctx.out, "href", &clean);
            }
            continue;
        }
        push_attr(ctx.out, &lname, value);
    }
    ctx.out.push_str(extra);
    if is_void(&tag) {
        ctx.out.push('>');
        return;
    }
    ctx.out.push('>');
    for c in node.children() {
        emit_child(c, ctx);
    }
    ctx.out.push_str("</");
    ctx.out.push_str(&tag);
    ctx.out.push('>');
}

fn emit_child(node: NodeRef<Node>, ctx: &mut RenderCtx) {
    match node.value() {
        Node::Element(_) => emit_element(node, ctx, ""),
        Node::Text(text) => ctx.out.push_str(&escape_text(&text[..])),
        _ => {}
    }
}

fn emit_img(el: &Element, ctx: &mut RenderCtx, extra: &str) {
    if let Some(src) = el.attr("src") {
        if let Some(html) = build_img(src, el.attr("alt"), ctx, extra) {
            ctx.out.push_str(&html);
        }
    }
}

// 把 EPUB 内图片落盘并改写为 /asset 链接；外部链接（http/data/blob）原样保留。返回 <img …> 字符串。
fn build_img(src: &str, alt: Option<&str>, ctx: &mut RenderCtx, extra: &str) -> Option<String> {
    if is_external(src) {
        let mut html = format!("<img src=\"{}\"", escape_attr(src));
        if let Some(a) = alt.filter(|a| !a.is_empty()) {
            html.push_str(&format!(" alt=\"{}\"", escape_attr(a)));
        }
        html.push_str(extra);
        html.push('>');
        return Some(html);
    }
    let zip_path = resolve_path(&ctx.chapter_path, src);
    if zip_path.is_empty() {
        return None;
    }
    let (idx, dims) = localize_asset(ctx, &zip_path)?;
    let mut html = format!("<img src=\"/api/books/{}/asset/{}\"", ctx.book_id, idx);
    if let Some((w, h)) = dims {
        html.push_str(&format!(" width=\"{w}\" height=\"{h}\""));
    }
    if let Some(a) = alt.filter(|a| !a.is_empty()) {
        html.push_str(&format!(" alt=\"{}\"", escape_attr(a)));
    }
    html.push_str(extra);
    html.push('>');
    Some(html)
}

fn localize_asset(ctx: &mut RenderCtx, zip_path: &str) -> Option<(usize, Option<(u32, u32)>)> {
    if let Some(rec) = ctx.assets.get(zip_path) {
        return Some((rec.idx, rec.dims));
    }
    let bytes = read_zip_bytes(ctx.zip, zip_path)?;
    let idx = ctx.assets.len();
    let ext = ext_of(zip_path);
    fs::create_dir_all(ctx.assets_dir).ok()?;
    fs::write(ctx.assets_dir.join(format!("{idx}.{ext}")), &bytes).ok()?;
    let dims = imagesize::blob_size(&bytes)
        .ok()
        .map(|s| (s.width as u32, s.height as u32));
    ctx.assets.insert(zip_path.to_string(), AssetRec { idx, dims });
    Some((idx, dims))
}

// 只裹一张 <image> 的 SVG（Calibre 整页封面常见）拆成等价 <img>，走普通图片渲染避免发虚。
fn svg_single_image(node: NodeRef<Node>, ctx: &mut RenderCtx, extra: &str) -> Option<String> {
    let inner: Vec<NodeRef<Node>> = node
        .descendants()
        .skip(1)
        .filter(|n| n.value().as_element().is_some())
        .collect();
    if inner.len() != 1 {
        return None;
    }
    let el = inner[0].value().as_element()?;
    if el.name().to_ascii_lowercase() != "image" {
        return None;
    }
    let href = attr_local(el, "href")?;
    let alt = node
        .value()
        .as_element()
        .and_then(|svg| attr_local(svg, "aria-label"))
        .or_else(|| attr_local(el, "alt"));
    build_img(href, alt, ctx, extra)
}

// ---- 子树查询助手 ----

// 按本地名取属性。scraper 把带命名空间的属性（如 xlink:href）归一为本地名 href，
// 而 Element::attr 会带命名空间匹配可能取不到，这里直接扫本地名。
fn attr_local<'a>(el: &'a Element, name: &str) -> Option<&'a str> {
    el.attrs().find(|(key, _)| *key == name).map(|(_, value)| value)
}

fn elem_text(node: NodeRef<Node>) -> String {
    ElementRef::wrap(node)
        .map(|e| e.text().collect::<String>())
        .unwrap_or_default()
}

fn has_block_descendant(node: NodeRef<Node>) -> bool {
    node.descendants().skip(1).any(|n| {
        n.value()
            .as_element()
            .map(|e| is_block_tag(&e.name().to_ascii_lowercase()))
            .unwrap_or(false)
    })
}

// include_image=true 时把 <image> 也算上（块标签分支用 img/svg/image，内联分支用 img/svg）。
fn has_media(node: NodeRef<Node>, include_image: bool) -> bool {
    node.descendants().skip(1).any(|n| {
        n.value()
            .as_element()
            .map(|e| {
                let name = e.name().to_ascii_lowercase();
                name == "img" || name == "svg" || (include_image && name == "image")
            })
            .unwrap_or(false)
    })
}

// ---- 标签/属性规则 ----

fn is_block_tag(tag: &str) -> bool {
    matches!(
        tag,
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "li" | "blockquote" | "pre" | "figure" | "img" | "svg" | "table" | "hr"
    )
}

fn is_disallowed(tag: &str) -> bool {
    matches!(
        tag,
        "script" | "style" | "iframe" | "object" | "embed" | "form" | "input" | "button" | "meta" | "base" | "link" | "head" | "title" | "noscript"
    )
}

fn is_void(tag: &str) -> bool {
    matches!(
        tag,
        "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input" | "link" | "meta" | "source" | "track" | "wbr"
    )
}

fn is_external(value: &str) -> bool {
    let v = value.trim_start().to_ascii_lowercase();
    v.starts_with("data:") || v.starts_with("blob:") || v.starts_with("http:") || v.starts_with("https:")
}

fn sanitize_href(value: &str) -> Option<String> {
    let lower = value.trim_start().to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("vbscript:") {
        return None;
    }
    if lower.starts_with("data:") {
        return None;
    }
    Some(value.to_string())
}

fn is_html_media(media_type: &str) -> bool {
    let m = media_type.to_ascii_lowercase();
    m.contains("xhtml") || m.contains("html") || m.contains("xml")
}

// ---- 路径 / 编码 ----

fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let trimmed = path.strip_prefix('/').unwrap_or(path);
    for part in trimmed.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    parts.join("/")
}

fn resolve_path(base_file: &str, relative: &str) -> String {
    let head = relative.split('#').next().unwrap_or("");
    let head = head.split('?').next().unwrap_or("");
    let clean = decode_path(head);
    if clean.is_empty() {
        return normalize_path(base_file);
    }
    let mut parts: Vec<String> = if clean.starts_with('/') {
        Vec::new()
    } else {
        let base = normalize_path(base_file);
        let mut v: Vec<String> = base.split('/').map(|s| s.to_string()).collect();
        v.pop();
        v
    };
    for seg in clean.split('/') {
        parts.push(seg.to_string());
    }
    normalize_path(&parts.join("/"))
}

fn decode_path(path: &str) -> String {
    percent_decode_str(path).decode_utf8_lossy().into_owned()
}

fn fragment_of(href: &str) -> String {
    match href.split_once('#') {
        Some((_, frag)) => decode_path(frag),
        None => String::new(),
    }
}

fn ext_of(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ext.is_empty() && ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        "img".to_string()
    }
}

fn escape_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn push_attr(out: &mut String, name: &str, value: &str) {
    out.push(' ');
    out.push_str(name);
    out.push_str("=\"");
    out.push_str(&escape_attr(value));
    out.push('"');
}

// ---- zip 读取 ----

fn read_zip_bytes(zip: &mut ZipArchive<File>, path: &str) -> Option<Vec<u8>> {
    let mut file = zip.by_name(path).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn zip_text(zip: &mut ZipArchive<File>, path: &str) -> Result<String, String> {
    let norm = normalize_path(path);
    let bytes = read_zip_bytes(zip, &norm).ok_or_else(|| format!("EPUB 缺少文件：{path}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
