//! The trusted review page frames a source-machine document on its own origin.

use super::{Body, View};
use http_body_util::{BodyExt, Full};
use hyper::{body::Bytes, header, HeaderMap, Response};
use tokio::io::{self, AsyncReadExt};

pub(super) const FRAME_PATH: &str = "/.well-known/genehub/preview-frame";
pub(super) const SCRIPT_PATH: &str = "/.well-known/genehub/preview-review.js";
const PREFIX_LIMIT: u64 = 4096;

const SCRIPT: &str = concat!(
    "(function(){\n",
    include_str!("../../../../packages/workbench/src/preview/previewReviewBridge.js"),
    r#"
    function isPlaceholderUrl() { return false; }
    window.addEventListener("scroll", scheduleMarks, true);
    window.addEventListener("resize", scheduleMarks);
    new MutationObserver(function(records) {
      mutationCount += records.length;
      scheduleMarks();
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    function reportLocation(action) {
      sendRuntime("review-location", "", { url: String(location.href).slice(0, 4096),
        title: String(document.title).slice(0, 500), action: action });
    }
    window.addEventListener("hashchange", function() { reportLocation("navigate"); });
    ["pushState", "replaceState"].forEach(function(method) {
      var original = history[method];
      history[method] = function() {
        var result = original.apply(history, arguments);
        reportLocation(method === "replaceState" ? "replace" : "navigate");
        return result;
      };
    });
    send("log", { topic: "html-preview-iframe", phase: "bridge-ready", url: safeUrl(location.href) });
    reportLocation("navigate");
    document.addEventListener("DOMContentLoaded", function() { reportLocation("ready"); }, { once: true });
    })();
"#,
);

pub(super) fn headers(headers: &mut HeaderMap, view: &View) {
    headers.insert(header::CONTENT_SECURITY_POLICY, view.frame_policy.clone());
    headers.insert(
        "cross-origin-resource-policy",
        header::HeaderValue::from_static("cross-origin"),
    );
    headers.insert(
        "cross-origin-embedder-policy",
        header::HeaderValue::from_static("require-corp"),
    );
}

pub(super) fn frame(view: &View) -> Response<Body> {
    document(
        view,
        "text/html; charset=utf-8",
        "<!doctype html><title>预览</title>",
    )
}

pub(super) fn script(view: &View) -> Response<Body> {
    document(view, "text/javascript; charset=utf-8", SCRIPT)
}

fn document(view: &View, media_type: &'static str, source: &'static str) -> Response<Body> {
    let body = Full::new(Bytes::from_static(source.as_bytes()))
        .map_err(|impossible| match impossible {})
        .boxed_unsync();
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, media_type)
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(body)
        .expect("valid preview review headers");
    headers(response.headers_mut(), view);
    response
}

pub(super) async fn read_prefix(
    file: &mut (impl tokio::io::AsyncRead + Unpin),
    original_length: u64,
    parent_origin: &header::HeaderValue,
) -> io::Result<(Bytes, u64)> {
    let mut prefix = Vec::new();
    file.take(PREFIX_LIMIT.min(original_length))
        .read_to_end(&mut prefix)
        .await?;
    let consumed = prefix.len() as u64;
    let insertion = script_insertion(&prefix);
    let parent = parent_origin.to_str().expect("validated HTTPS origin");
    let tag = format!(r#"<script src="{SCRIPT_PATH}" data-parent-origin="{parent}"></script>"#);
    prefix.splice(insertion..insertion, tag.bytes());
    Ok((Bytes::from(prefix), consumed))
}

fn script_insertion(prefix: &[u8]) -> usize {
    let bom = usize::from(prefix.starts_with(b"\xef\xbb\xbf")) * 3;
    let mut cursor = bom;
    let mut fallback = bom;
    while let Some(rest) = prefix.get(cursor..) {
        let rest = rest.trim_ascii_start();
        cursor = prefix.len() - rest.len();
        if rest.starts_with(b"<!--") {
            let Some(end) = rest.windows(3).position(|window| window == b"-->") else {
                break;
            };
            cursor += end + 3;
            continue;
        }
        let ends = |tag: &[u8]| {
            rest.get(..tag.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(tag))
                && rest
                    .get(tag.len())
                    .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>')
        };
        if !ends(b"<!doctype") && !ends(b"<html") && !ends(b"<head") {
            break;
        }
        let mut quote = None;
        let Some(end) = rest.iter().position(|&byte| match quote {
            Some(active) if active == byte => {
                quote = None;
                false
            }
            Some(_) => false,
            None if byte == b'\"' || byte == b'\'' => {
                quote = Some(byte);
                false
            }
            None => byte == b'>',
        }) else {
            break;
        };
        cursor += end + 1;
        fallback = cursor;
        if ends(b"<head") {
            break;
        }
    }
    fallback
}
