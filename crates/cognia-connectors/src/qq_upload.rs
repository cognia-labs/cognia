//! QQ binary and chunked media upload, behind the existing media command.
//! Uploading never sends a chat message; the adapter owns passive delivery.
use std::{collections::HashSet, future::Future, time::Duration};

use base64::Engine as _;
use bytes::Bytes;
use cognia_net::{guarded_http, proxy_config};
use md5::{Digest, Md5};
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::Sha1;

use crate::types::{ConnectorMediaUploadRequest, TauriHttpResponse};

const MAX_BYTES: usize = 200_000_000;
const DIRECT_BYTES: usize = 5_000_000;
const MD5_PREFIX_BYTES: usize = 10_002_432;
const RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);
// Prepare/part-finish are documented at 10QPS. Share a conservative cadence
// across native uploads rather than repeatedly restarting at the same limit.
static API_NEXT_SLOT: once_cell::sync::Lazy<tokio::sync::Mutex<tokio::time::Instant>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(tokio::time::Instant::now()));

async fn pace_api(limiter: &tokio::sync::Mutex<tokio::time::Instant>) {
    let mut next = limiter.lock().await;
    tokio::time::sleep_until(*next).await;
    *next = tokio::time::Instant::now() + Duration::from_millis(110);
}

fn validation(message: &str) -> String {
    format!("QQ upload validation: {message}")
}
fn protocol() -> String {
    "QQ upload protocol response is invalid".into()
}

fn endpoint(req: &ConnectorMediaUploadRequest) -> Result<url::Url, String> {
    let options = req
        .qq
        .as_ref()
        .ok_or_else(|| validation("missing upload mode"))?;
    if !(1..=4).contains(&options.file_type)
        || options.file_name.trim().is_empty()
        || options.file_name.chars().count() > 256
        || options
            .file_name
            .chars()
            .any(|c| c.is_control() || c == '/' || c == '\\')
        || matches!(options.file_name.as_str(), "." | "..")
        || req.multipart.is_some()
    {
        return Err(validation("invalid media type, filename or upload mode"));
    }
    let url = url::Url::parse(&req.upload_url).map_err(|_| validation("invalid API endpoint"))?;
    let parts: Vec<_> = url.path().rsplit('/').take(4).collect();
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (if options.reusable_asset {
            url.path() != "/v2/media-images/prepare" || options.file_type != 1
        } else {
            parts.len() != 4
                || parts[0] != "files"
                || parts[1].is_empty()
                || !matches!(parts[2], "users" | "groups")
                || parts[3] != "v2"
        })
    {
        return Err(validation("invalid QQ scene endpoint"));
    }
    Ok(url)
}

async fn response(mut response: reqwest::Response) -> Result<TauriHttpResponse, String> {
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "QQ upload response read failed")?
    {
        if chunk.len() > RESPONSE_BYTES.saturating_sub(bytes.len()) {
            return Err(protocol());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(TauriHttpResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

fn accepted(response: &TauriHttpResponse, empty_success: bool) -> bool {
    if !(200..300).contains(&response.status) || response.status == 202 {
        return false;
    }
    if response.body.trim().is_empty() {
        return empty_success;
    }
    let Ok(Value::Object(body)) = serde_json::from_str::<Value>(&response.body) else {
        return false;
    };
    body.get("err_code")
        .or_else(|| body.get("code"))
        .is_none_or(|code| code.as_i64() == Some(0))
}

async fn api(
    req: &ConnectorMediaUploadRequest,
    url: &url::Url,
    body: Value,
) -> Result<TauriHttpResponse, String> {
    // API credentials may only go to the original API path/origin, with no redirect.
    let client = proxy_config::managed_client(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none()),
        url.as_str(),
    )
    .map_err(|_| "QQ upload API client failed")?;
    let mut request = client.post(url.clone()).json(&body);
    if let Some(headers) = &req.headers {
        for (name, value) in headers {
            if name.eq_ignore_ascii_case("content-type") {
                continue;
            }
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| validation("invalid API header"))?;
            let value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| validation("invalid API header"))?;
            request = request.header(name, value);
        }
    }
    pace_api(&API_NEXT_SLOT).await;
    response(
        request
            .send()
            .await
            .map_err(|_| "QQ upload API request failed")?,
    )
    .await
}

#[derive(Deserialize)]
struct Prepare {
    upload_id: String,
    block_size: String,
    parts: Vec<PreparedPart>,
}
#[derive(Deserialize)]
struct PreparedPart {
    index: usize,
    presigned_url: String,
    block_size: String,
}
struct Part {
    index: usize,
    url: String,
    start: usize,
    end: usize,
}

fn positive_size(value: &str) -> Result<usize, String> {
    let size = value.parse::<usize>().map_err(|_| protocol())?;
    if size == 0 || size > MAX_BYTES || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(protocol());
    }
    Ok(size)
}

fn plan(body: &str, size: usize) -> Result<(String, Vec<Part>), String> {
    let mut prepared: Prepare = serde_json::from_str(body).map_err(|_| protocol())?;
    if prepared.upload_id.is_empty()
        || prepared.upload_id.len() > 2048
        || prepared.upload_id.chars().any(char::is_control)
        || prepared.parts.is_empty()
        || prepared.parts.len() > 10_000
    {
        return Err(protocol());
    }
    let block = positive_size(&prepared.block_size)?;
    prepared.parts.sort_by_key(|part| part.index);
    let count = prepared.parts.len();
    let mut parts = Vec::with_capacity(count);
    let mut urls = HashSet::new();
    let mut offset = 0usize;
    for (index, part) in prepared.parts.into_iter().enumerate() {
        let part_size = positive_size(&part.block_size)?;
        let url = url::Url::parse(&part.presigned_url).map_err(|_| protocol())?;
        if part.index != index
            || part_size > block
            || part.presigned_url.len() > 16_384
            || !urls.insert(part.presigned_url.clone())
            || url.fragment().is_some()
        {
            return Err(protocol());
        }
        guarded_http::DownloadPolicy {
            allowed_origins: vec![url.origin().ascii_serialization()],
            max_bytes: guarded_http::MAX_DOWNLOAD_BYTES,
        }
        .validate(&url)
        .map_err(|_| protocol())?;
        if offset >= size {
            return Err(protocol());
        }
        let end = offset
            .checked_add(part_size)
            .ok_or_else(protocol)?
            .min(size);
        if index + 1 != count && end == size {
            return Err(protocol());
        }
        parts.push(Part {
            index,
            url: part.presigned_url,
            start: offset,
            end,
        });
        offset = end;
    }
    if offset != size {
        return Err(protocol());
    }
    Ok((prepared.upload_id, parts))
}

async fn put(url: String, bytes: Bytes) -> Result<(), String> {
    put_with_type(url, bytes, "application/octet-stream").await
}
async fn put_with_type(url: String, bytes: Bytes, content_type: &str) -> Result<(), String> {
    let timeout = Duration::from_secs(120);
    tokio::time::timeout(timeout, async {
        let request = reqwest::Client::new()
            .put(url)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .body(bytes);
        let response = guarded_http::send_pinned_public_upload(
            request,
            |_| Ok(reqwest::Client::builder().timeout(timeout)),
            timeout,
        )
        .await?;
        let result = response.status();
        response_body_for_storage(response).await?;
        if !result.is_success() || result.as_u16() == 202 {
            return Err(format!(
                "QQ upload storage returned HTTP {}",
                result.as_u16()
            ));
        }
        Ok(())
    })
    .await
    .map_err(|_| "QQ upload storage timed out".to_string())?
}

async fn response_body_for_storage(mut response: reqwest::Response) -> Result<(), String> {
    let mut size = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "QQ upload storage read failed")?
    {
        size += chunk.len();
        if size > RESPONSE_BYTES {
            return Err("QQ upload storage response is too large".into());
        }
    }
    Ok(())
}

fn media_type(file_type: u8, bytes: usize) -> u8 {
    let soft_limit = match file_type {
        1 | 3 => 20_000_000,
        2 => 30_000_000,
        _ => MAX_BYTES,
    };
    if bytes > soft_limit {
        4
    } else {
        file_type
    }
}

async fn snapshot<F, Fut>(
    req: &ConnectorMediaUploadRequest,
    bytes: Bytes,
    put: F,
) -> Result<String, String>
where
    F: Fn(String, Bytes) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let url = endpoint(req)?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(validation("file must contain 1..200000000 bytes"));
    }
    let options = req
        .qq
        .as_ref()
        .ok_or_else(|| validation("missing upload mode"))?;
    let file_type = media_type(options.file_type, bytes.len());
    let mut body =
        json!({"file_type":file_type,"file_name":options.file_name,"srv_send_msg":false});
    if bytes.len() <= DIRECT_BYTES {
        body["file_data"] = base64::engine::general_purpose::STANDARD
            .encode(&bytes)
            .into();
        return serde_json::to_string(&api(req, &url, body).await?).map_err(|_| protocol());
    }
    let hash_bytes = bytes.clone();
    let (md5, sha1, prefix) = tokio::task::spawn_blocking(move || {
        (
            hex::encode(Md5::digest(&hash_bytes)),
            hex::encode(Sha1::digest(&hash_bytes)),
            hex::encode(Md5::digest(
                &hash_bytes[..hash_bytes.len().min(MD5_PREFIX_BYTES)],
            )),
        )
    })
    .await
    .map_err(|_| "QQ upload hashing failed")?;
    let mut stage = url.clone();
    let base_path = url.path().strip_suffix("/files").ok_or_else(protocol)?;
    stage.set_path(&format!("{base_path}/upload_prepare"));
    let prepared = api(req,&stage,json!({"file_type":file_type,"file_size":bytes.len().to_string(),"file_name":options.file_name,"md5":md5,"sha1":sha1,"md5_10m":prefix})).await?;
    if !accepted(&prepared, false) {
        return serde_json::to_string(&prepared).map_err(|_| protocol());
    }
    let (upload_id, parts) = plan(&prepared.body, bytes.len())?;
    stage.set_path(&format!("{base_path}/upload_part_finish"));
    for part in parts {
        let chunk = bytes.slice(part.start..part.end);
        let hash_bytes = chunk.clone();
        let md5 = tokio::task::spawn_blocking(move || hex::encode(Md5::digest(&hash_bytes)))
            .await
            .map_err(|_| "QQ upload hashing failed")?;
        put(part.url, chunk).await?;
        let finished = api(req,&stage,json!({"upload_id":upload_id,"part_index":part.index,"block_size":(part.end-part.start).to_string(),"md5":md5})).await?;
        if !accepted(&finished, true) {
            return serde_json::to_string(&finished).map_err(|_| protocol());
        }
    }
    body["upload_id"] = upload_id.into();
    serde_json::to_string(&api(req, &url, body).await?).map_err(|_| protocol())
}

async fn asset_snapshot<F, Fut>(
    req: &ConnectorMediaUploadRequest,
    bytes: Bytes,
    put: F,
) -> Result<String, String>
where
    F: Fn(String, Bytes, String) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let url = endpoint(req)?;
    let options = req.qq.as_ref().ok_or_else(protocol)?;
    let mime = req.content_type.as_deref().unwrap_or("");
    let ext = options
        .file_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let matched = matches!(
        (mime, ext.as_str()),
        ("image/png", "png")
            | ("image/jpeg", "jpg" | "jpeg")
            | ("image/gif", "gif")
            | ("image/webp", "webp")
    );
    let valid_image = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if bytes.is_empty() || bytes.len() > 10_000_000 || !matched || !valid_image {
        return Err(validation(
            "invalid reusable image format, filename or size",
        ));
    }
    let md5 = hex::encode(Md5::digest(&bytes));
    let sha1 = hex::encode(Sha1::digest(&bytes));
    let prepared = api(req, &url, json!({"file_name":options.file_name,"file_size":bytes.len(),"content_type":mime,"md5":md5,"sha1":sha1})).await?;
    if !accepted(&prepared, false) {
        return serde_json::to_string(&prepared).map_err(|_| protocol());
    }
    let body: Value = serde_json::from_str(&prepared.body).map_err(|_| protocol())?;
    let upload_id = body
        .get("upload_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 2048)
        .ok_or_else(protocol)?;
    let storage = body
        .get("presigned_url")
        .and_then(Value::as_str)
        .ok_or_else(protocol)?;
    let parsed = url::Url::parse(storage).map_err(|_| protocol())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(protocol());
    }
    put(storage.to_string(), bytes, mime.to_string()).await?;
    let mut complete = url.clone();
    complete.set_path("/v2/media-images/complete");
    serde_json::to_string(&api(req, &complete, json!({"upload_id":upload_id,"md5":md5})).await?)
        .map_err(|_| protocol())
}

pub(crate) async fn upload(req: &ConnectorMediaUploadRequest) -> Result<String, String> {
    endpoint(req)?;
    tokio::time::timeout(UPLOAD_TIMEOUT, async {
        let limit = if req
            .qq
            .as_ref()
            .is_some_and(|options| options.reusable_asset)
        {
            10_000_000
        } else {
            MAX_BYTES
        };
        let bytes = crate::media_upload::read_source_bytes(req, limit)
            .await
            .map_err(|_| {
                validation(&format!(
                    "source unavailable, invalid or exceeds {limit} bytes"
                ))
            })?;
        if req
            .qq
            .as_ref()
            .is_some_and(|options| options.reusable_asset)
        {
            asset_snapshot(req, bytes, |url, bytes, mime| async move {
                put_with_type(url, bytes, &mime).await
            })
            .await
        } else {
            snapshot(req, bytes, put).await
        }
    })
    .await
    .map_err(|_| "QQ upload deadline exceeded".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reusable_images_preserve_hashes_mime_bytes_and_only_return_complete_receipts() {
        use wiremock::{
            matchers::{body_partial_json, method, path},
            Mock, MockServer, ResponseTemplate,
        };
        let server = MockServer::start().await;
        let bytes = Bytes::from_static(b"\x89PNG\r\n\x1a\nimage-bytes");
        let md5 = hex::encode(Md5::digest(&bytes));
        let sha1 = hex::encode(Sha1::digest(&bytes));
        let mut req = request(&server, "users");
        req.upload_url = format!("{}/v2/media-images/prepare", server.uri());
        req.qq.as_mut().unwrap().reusable_asset = true;
        req.qq.as_mut().unwrap().file_type = 1;
        req.qq.as_mut().unwrap().file_name = "image.png".into();
        req.content_type = Some("image/png".into());
        Mock::given(method("POST")).and(path("/v2/media-images/prepare"))
            .and(body_partial_json(json!({"file_name":"image.png","file_size":bytes.len(),"content_type":"image/png","md5":md5,"sha1":sha1})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"upload_id":"prepared","presigned_url":"https://storage.example.org/image?signature=SECRET"}))).expect(1).mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/v2/media-images/complete"))
            .and(body_partial_json(json!({"upload_id":"prepared","md5":md5})))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"image_id":"image","url":"qqbot-media://image/v1/token","ttl":7776000}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        let expected = bytes.clone();
        let output = asset_snapshot(&req, bytes, move |url, uploaded, mime| {
            assert_eq!(url, "https://storage.example.org/image?signature=SECRET");
            assert_eq!(uploaded, expected);
            assert_eq!(mime, "image/png");
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert!(output.contains("qqbot-media://image/v1/token"));
        assert!(!output.contains("SECRET"));
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests
            .iter()
            .all(|r| r.headers.get("authorization").unwrap() == "QQBot API_SECRET"));
    }

    #[tokio::test]
    async fn reusable_images_validate_format_before_prepare_and_stop_before_complete_on_put_failure(
    ) {
        let server = MockServer::start().await;
        let mut req = request(&server, "groups");
        req.upload_url = format!("{}/v2/media-images/prepare", server.uri());
        req.qq.as_mut().unwrap().reusable_asset = true;
        req.qq.as_mut().unwrap().file_type = 1;
        req.qq.as_mut().unwrap().file_name = "image.png".into();
        req.content_type = Some("image/png".into());
        assert!(
            asset_snapshot(&req, Bytes::from_static(b"not png"), |_, _, _| async {
                panic!("invalid source must not upload")
            })
            .await
            .is_err()
        );
        assert!(server.received_requests().await.unwrap().is_empty());
        Mock::given(method("POST"))
            .and(path("/v2/media-images/prepare"))
            .respond_with(ResponseTemplate::new(200).set_body_json(
                json!({"upload_id":"id","presigned_url":"https://storage.example.org/image"}),
            ))
            .expect(1)
            .mount(&server)
            .await;
        assert!(asset_snapshot(
            &req,
            Bytes::from_static(b"\x89PNG\r\n\x1a\ncontent"),
            |_, _, _| async { Err("storage rejected".into()) }
        )
        .await
        .is_err());
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
    #[tokio::test]
    async fn native_api_pacing_stays_below_ten_requests_per_second() {
        let limiter = tokio::sync::Mutex::new(tokio::time::Instant::now());
        let mut last = None;
        for _ in 0..3 {
            pace_api(&limiter).await;
            let now = tokio::time::Instant::now();
            if let Some(previous) = last {
                assert!(now.duration_since(previous) >= Duration::from_millis(100));
            }
            last = Some(now);
        }
    }
    use wiremock::{
        matchers::{method, path, path_regex},
        Mock, MockServer, ResponseTemplate,
    };

    fn request(server: &MockServer, scene: &str) -> ConnectorMediaUploadRequest {
        serde_json::from_value(json!({"uploadUrl":format!("{}/v2/{scene}/target/files",server.uri()),
            "qq":{"fileType":4,"fileName":"file.bin"},"headers":{"Authorization":"QQBot API_SECRET"},"responseMode":"http"})).unwrap()
    }
    fn prepared(size: usize) -> Value {
        json!({"upload_id":"upload-id","block_size":"2000000","parts":(0..size.div_ceil(2_000_000)).rev().map(|index|json!({"index":index,"block_size":"2000000","presigned_url":format!("https://storage.example/part/{index}?sign=URL_SECRET")})).collect::<Vec<_>>()})
    }
    fn large_bytes() -> Bytes {
        Bytes::from(
            (0..DIRECT_BYTES + 3)
                .map(|i| (i % 251) as u8)
                .collect::<Vec<_>>(),
        )
    }

    #[tokio::test]
    async fn chunked_users_and_groups_preserve_bytes_hashes_order_and_auth_isolation() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        for scene in ["users", "groups"] {
            let server = MockServer::start().await;
            let bytes = large_bytes();
            Mock::given(method("POST"))
                .and(path(format!("/v2/{scene}/target/upload_prepare")))
                .respond_with(ResponseTemplate::new(200).set_body_json(prepared(bytes.len())))
                .expect(1)
                .mount(&server)
                .await;
            Mock::given(method("PUT"))
                .and(path_regex("/part/[0-9]+"))
                .respond_with(ResponseTemplate::new(200))
                .expect(3)
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path(format!("/v2/{scene}/target/upload_part_finish")))
                .respond_with(ResponseTemplate::new(if scene == "users" {
                    204
                } else {
                    200
                }))
                .expect(3)
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path(format!("/v2/{scene}/target/files")))
                .and(wiremock::matchers::body_partial_json(
                    json!({"upload_id":"upload-id","srv_send_msg":false,"file_type":4}),
                ))
                .respond_with(
                    ResponseTemplate::new(200).set_body_json(json!({"file_info":"READY"})),
                )
                .expect(1)
                .mount(&server)
                .await;
            let storage = server.uri();
            let result = snapshot(
                &request(&server, scene),
                bytes.clone(),
                move |url, bytes| {
                    let storage = storage.clone();
                    async move {
                        let url = url::Url::parse(&url).unwrap();
                        let response = reqwest::Client::new()
                            .put(format!("{storage}{}", url.path()))
                            .body(bytes)
                            .send()
                            .await
                            .unwrap();
                        assert!(response.status().is_success());
                        Ok(())
                    }
                },
            )
            .await
            .unwrap();
            let result: Value = serde_json::from_str(&result).unwrap();
            assert_eq!(result["status"], 200);
            assert_eq!(
                serde_json::from_str::<Value>(result["body"].as_str().unwrap()).unwrap()
                    ["file_info"],
                "READY"
            );
            let requests = server.received_requests().await.unwrap();
            let prepare: Value = serde_json::from_slice(&requests[0].body).unwrap();
            assert_eq!(prepare["file_size"], bytes.len().to_string());
            assert_eq!(prepare["md5"], hex::encode(Md5::digest(&bytes)));
            assert_eq!(prepare["sha1"], hex::encode(Sha1::digest(&bytes)));
            let mut reconstructed = Vec::new();
            for index in 0..3 {
                let put = &requests[1 + index * 2];
                let finish = &requests[2 + index * 2];
                assert_eq!(put.method.as_str(), "PUT");
                assert_eq!(put.url.path(), format!("/part/{index}"));
                assert!(!put.headers.contains_key("authorization"));
                reconstructed.extend_from_slice(&put.body);
                let finish_body: Value = serde_json::from_slice(&finish.body).unwrap();
                assert_eq!(finish_body["part_index"], index);
                assert_eq!(finish_body["block_size"], put.body.len().to_string());
                assert_eq!(finish_body["md5"], hex::encode(Md5::digest(&put.body)));
                assert_eq!(finish.headers["authorization"], "QQBot API_SECRET");
            }
            assert_eq!(reconstructed.as_slice(), bytes.as_ref());
            let merge: Value = serde_json::from_slice(&requests.last().unwrap().body).unwrap();
            assert!(merge.get("url").is_none() && merge.get("file_data").is_none());
        }
    }

    #[tokio::test]
    async fn prefix_hash_uses_exactly_10002432_bytes_and_api_errors_stop_before_storage() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"err_code":11243})))
            .expect(1)
            .mount(&server)
            .await;
        let mut bytes = vec![b'a'; MD5_PREFIX_BYTES];
        bytes.push(b'b');
        let result = snapshot(
            &request(&server, "groups"),
            Bytes::from(bytes),
            |_, _| async { panic!("must not PUT after API rejection") },
        )
        .await
        .unwrap();
        assert!(result.contains("11243"));
        let requests = server.received_requests().await.unwrap();
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        // Independent hashlib vectors, including the deliberately non-MiB prefix.
        assert_eq!(body["md5"], "1bbed7c97dd511cc8154942c5ed1d80d");
        assert_eq!(body["sha1"], "a7867713281b972ad72ad1f90361e7a3f7c1a929");
        assert_eq!(body["md5_10m"], "1052ca143d1cb223562bc8c36d67a220");
    }

    #[tokio::test]
    async fn part_failure_or_finish_rejection_never_merges_or_continues() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        for storage_failed in [true, false] {
            let server = MockServer::start().await;
            let bytes = large_bytes();
            Mock::given(path("/v2/users/target/upload_prepare"))
                .respond_with(ResponseTemplate::new(200).set_body_json(prepared(bytes.len())))
                .expect(1)
                .mount(&server)
                .await;
            Mock::given(path("/v2/users/target/upload_part_finish"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(json!({"err_code":40093002,"message":"quota"})),
                )
                .expect(if storage_failed { 0 } else { 1 })
                .mount(&server)
                .await;
            let puts = std::sync::atomic::AtomicUsize::new(0);
            let result = snapshot(&request(&server, "users"), bytes, |_, _| {
                puts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    if storage_failed {
                        Err("QQ upload storage failed".into())
                    } else {
                        Ok(())
                    }
                }
            })
            .await;
            if storage_failed {
                assert!(result.unwrap_err().contains("storage failed"));
            } else {
                assert!(result.unwrap().contains("40093002"));
            }
            assert_eq!(puts.load(std::sync::atomic::Ordering::SeqCst), 1);
            assert!(!server
                .received_requests()
                .await
                .unwrap()
                .iter()
                .any(|r| r.url.path().ends_with("/files")));
        }
    }

    #[test]
    fn complete_plan_validation_prevents_missing_duplicate_and_unsafe_parts() {
        let original = prepared(DIRECT_BYTES + 3);
        assert!(plan(&original.to_string(), DIRECT_BYTES + 3).is_ok());
        for mutation in 0..7 {
            let mut body = original.clone();
            match mutation {
                0 => body["block_size"] = "0".into(),
                1 => body["parts"][0]["index"] = 0.into(),
                2 => body["parts"][0]["block_size"] = "200000001".into(),
                3 => {
                    body["parts"][0]["presigned_url"] =
                        "https://127.0.0.1/private?sign=SECRET".into()
                }
                4 => {
                    body["parts"][0]["presigned_url"] =
                        "https://user:SECRET@public.example/upload".into()
                }
                5 => body["parts"][0]["presigned_url"] = "http://public.example/upload".into(),
                _ => {
                    body["parts"].as_array_mut().unwrap().remove(0);
                }
            }
            assert!(plan(&body.to_string(), DIRECT_BYTES + 3).is_err());
        }
    }

    #[tokio::test]
    async fn direct_boundary_uses_base64_and_never_follows_api_redirects() {
        proxy_config::apply_current(proxy_config::ProxyConfig::default()).unwrap();
        let server = MockServer::start().await;
        Mock::given(path("/v2/groups/target/files"))
            .respond_with(ResponseTemplate::new(307).insert_header("Location", "/do-not-follow"))
            .expect(1)
            .mount(&server)
            .await;
        let bytes = Bytes::from(vec![0x80; DIRECT_BYTES]);
        let result = snapshot(&request(&server, "groups"), bytes, |_, _| async {
            panic!("direct upload must not PUT")
        })
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&result).unwrap()["status"],
            307
        );
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(body["file_data"].as_str().unwrap())
                .unwrap(),
            vec![0x80; DIRECT_BYTES]
        );
        assert_eq!(body["srv_send_msg"], false);
    }

    #[tokio::test]
    async fn native_size_and_empty_sources_fail_before_upload_and_soft_limits_become_files() {
        let server = MockServer::start().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("too-large");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_BYTES as u64 + 1).unwrap();
        let mut req = request(&server, "users");
        req.local_path = Some(path.to_string_lossy().into_owned());
        assert!(upload(&req)
            .await
            .unwrap_err()
            .starts_with("QQ upload validation:"));
        assert!(
            snapshot(&request(&server, "users"), Bytes::new(), |_, _| async {
                Ok(())
            })
            .await
            .unwrap_err()
            .starts_with("QQ upload validation:")
        );
        assert!(server.received_requests().await.unwrap().is_empty());
        assert_eq!(media_type(1, 20_000_001), 4);
        assert_eq!(media_type(2, 30_000_001), 4);
        assert_eq!(media_type(3, 20_000_000), 3);
        assert_eq!(media_type(4, MAX_BYTES), 4);
    }
}
