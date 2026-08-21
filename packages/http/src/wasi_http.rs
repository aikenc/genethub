//! `reqwest`'s shape over `wasi:http`.
//!
//! Every import used here is non-blocking by construction: `pollable.ready()`,
//! `input-stream.read` and `future-incoming-response.get` all answer
//! immediately, and we come back later on a timer. The blocking twins
//! (`pollable.block`, `blocking-read`) would park the guest's whole fiber and
//! stall every other session in the process — see the v2 proposal §6.10.
//!
//! Resource drop order is load-bearing. A `pollable` is a child of whatever it
//! subscribes to, and Wasmtime's table refuses to drop a parent that still has
//! children, so every `subscribe()` here is scoped to end before its parent.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use futures_util::Stream;
use serde::Serialize;

pub use http::header;
pub use http::StatusCode;
pub use url::Url;

use wasi::http::outgoing_handler;
use wasi::http::types::{
    ErrorCode, Fields, IncomingBody, IncomingResponse, Method, OutgoingBody, OutgoingRequest,
    RequestOptions, Scheme,
};
use wasi::io::poll::Pollable;
use wasi::io::streams::{InputStream, StreamError};

/// Read granularity for response bodies. Streaming providers send far smaller
/// frames than this; the ceiling only matters on bulk downloads.
const READ_CHUNK: u64 = 64 * 1024;

/// A body may go quiet for a long time between SSE frames while a model
/// thinks. Anything shorter turns a slow first token into a transport error.
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Backoff bounds for the poll loop. The floor keeps first-token latency low;
/// the ceiling keeps a long quiet download from burning host calls.
const POLL_MIN: Duration = Duration::from_millis(1);
const POLL_MAX: Duration = Duration::from_millis(16);

/// Parks until `pollable` says it is ready, without blocking the fiber.
///
/// Each `ready()` is a host call, and under `add_to_linker_async` that is an
/// await point in the host — which is what lets the host's connection task make
/// the progress we are waiting on.
async fn wait(pollable: &Pollable) {
    let mut delay = POLL_MIN;
    while !pollable.ready() {
        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(POLL_MAX);
    }
}

#[derive(Debug)]
pub struct Error {
    message: String,
    timeout: bool,
    status: Option<StatusCode>,
}

impl Error {
    fn new(message: impl Into<String>) -> Self {
        Error {
            message: message.into(),
            timeout: false,
            status: None,
        }
    }

    fn from_code(context: &str, code: ErrorCode) -> Self {
        let timeout = matches!(
            code,
            ErrorCode::ConnectionTimeout
                | ErrorCode::ConnectionReadTimeout
                | ErrorCode::ConnectionWriteTimeout
                | ErrorCode::DnsTimeout
        );
        Error {
            message: format!("{context}: {code:?}"),
            timeout,
            status: None,
        }
    }

    pub fn is_timeout(&self) -> bool {
        self.timeout
    }

    pub fn is_status(&self) -> bool {
        self.status.is_some()
    }

    pub fn status(&self) -> Option<StatusCode> {
        self.status
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

pub trait IntoUrl {
    fn into_url(self) -> Result<Url, Error>;
}

impl IntoUrl for Url {
    fn into_url(self) -> Result<Url, Error> {
        Ok(self)
    }
}

impl IntoUrl for &str {
    fn into_url(self) -> Result<Url, Error> {
        Url::parse(self).map_err(|e| Error::new(format!("invalid url {self:?}: {e}")))
    }
}

impl IntoUrl for String {
    fn into_url(self) -> Result<Url, Error> {
        self.as_str().into_url()
    }
}

impl IntoUrl for &String {
    fn into_url(self) -> Result<Url, Error> {
        self.as_str().into_url()
    }
}

pub trait AsHeaderName {
    fn header_name(&self) -> String;
}

impl AsHeaderName for &str {
    fn header_name(&self) -> String {
        (*self).to_string()
    }
}

impl AsHeaderName for String {
    fn header_name(&self) -> String {
        self.clone()
    }
}

impl AsHeaderName for header::HeaderName {
    fn header_name(&self) -> String {
        self.as_str().to_string()
    }
}

impl AsHeaderName for &header::HeaderName {
    fn header_name(&self) -> String {
        self.as_str().to_string()
    }
}

pub mod redirect {
    use std::sync::Arc;

    use super::Url;

    pub struct Action(pub(crate) bool);

    pub struct Attempt {
        pub(crate) url: Url,
        pub(crate) previous: Vec<Url>,
    }

    impl Attempt {
        pub fn url(&self) -> &Url {
            &self.url
        }

        pub fn previous(&self) -> &[Url] {
            &self.previous
        }

        pub fn follow(self) -> Action {
            Action(true)
        }

        pub fn stop(self) -> Action {
            Action(false)
        }
    }

    #[derive(Clone)]
    pub enum Policy {
        Limited(usize),
        Custom(Arc<dyn Fn(Attempt) -> Action + Send + Sync>),
    }

    impl Policy {
        pub fn none() -> Self {
            Policy::Limited(0)
        }

        pub fn limited(max: usize) -> Self {
            Policy::Limited(max)
        }

        pub fn custom<F>(f: F) -> Self
        where
            F: Fn(Attempt) -> Action + Send + Sync + 'static,
        {
            Policy::Custom(Arc::new(f))
        }
    }

    impl Default for Policy {
        fn default() -> Self {
            Policy::Limited(10)
        }
    }
}

#[derive(Clone)]
struct Settings {
    connect_timeout: Option<Duration>,
    timeout: Option<Duration>,
    redirect: redirect::Policy,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            connect_timeout: None,
            timeout: None,
            redirect: redirect::Policy::default(),
        }
    }
}

#[derive(Clone)]
pub struct Client {
    settings: Arc<Settings>,
}

impl Default for Client {
    fn default() -> Self {
        Client::new()
    }
}

impl Client {
    pub fn new() -> Self {
        Client {
            settings: Arc::new(Settings::default()),
        }
    }

    pub fn builder() -> ClientBuilder {
        ClientBuilder {
            settings: Settings::default(),
        }
    }

    pub fn get(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::Get, url)
    }

    pub fn post(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::Post, url)
    }

    pub fn put(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::Put, url)
    }

    pub fn delete(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::Delete, url)
    }

    pub fn patch(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::Patch, url)
    }

    pub fn head(&self, url: impl IntoUrl) -> RequestBuilder {
        self.request(Method::Head, url)
    }

    fn request(&self, method: Method, url: impl IntoUrl) -> RequestBuilder {
        let (url, error) = match url.into_url() {
            Ok(url) => (Some(url), None),
            Err(e) => (None, Some(e)),
        };
        RequestBuilder {
            settings: self.settings.clone(),
            method,
            url,
            headers: Vec::new(),
            body: None,
            timeout: None,
            error,
        }
    }
}

pub struct ClientBuilder {
    settings: Settings,
}

impl ClientBuilder {
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.settings.connect_timeout = Some(timeout);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.settings.timeout = Some(timeout);
        self
    }

    /// Connection reuse is the host's business here; the guest holds no pool.
    pub fn pool_idle_timeout(self, _timeout: Duration) -> Self {
        self
    }

    pub fn user_agent(self, _value: impl Into<String>) -> Self {
        self
    }

    pub fn redirect(mut self, policy: redirect::Policy) -> Self {
        self.settings.redirect = policy;
        self
    }

    pub fn build(self) -> Result<Client, Error> {
        Ok(Client {
            settings: Arc::new(self.settings),
        })
    }
}

pub struct RequestBuilder {
    settings: Arc<Settings>,
    method: Method,
    url: Option<Url>,
    headers: Vec<(String, Vec<u8>)>,
    body: Option<Vec<u8>>,
    timeout: Option<Duration>,
    error: Option<Error>,
}

impl RequestBuilder {
    pub fn header(mut self, name: impl AsHeaderName, value: impl Into<String>) -> Self {
        self.headers
            .push((name.header_name(), value.into().into_bytes()));
        self
    }

    pub fn bearer_auth(self, token: impl std::fmt::Display) -> Self {
        self.header("authorization", format!("Bearer {token}"))
    }

    pub fn json<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        match serde_json::to_vec(value) {
            Ok(body) => {
                if !self
                    .headers
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case("content-type"))
                {
                    self.headers
                        .push(("content-type".into(), b"application/json".to_vec()));
                }
                self.body = Some(body);
            }
            Err(e) => self.error = Some(Error::new(format!("serializing request body: {e}"))),
        }
        self
    }

    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn query<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        match serde_urlencoded::to_string(value) {
            Ok(query) => {
                if let Some(url) = self.url.as_mut() {
                    let merged = match url.query() {
                        Some(existing) if !existing.is_empty() && !query.is_empty() => {
                            format!("{existing}&{query}")
                        }
                        Some(existing) if query.is_empty() => existing.to_string(),
                        _ => query,
                    };
                    url.set_query(if merged.is_empty() {
                        None
                    } else {
                        Some(&merged)
                    });
                }
            }
            Err(e) => self.error = Some(Error::new(format!("serializing query: {e}"))),
        }
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub async fn send(self) -> Result<Response, Error> {
        if let Some(error) = self.error {
            return Err(error);
        }
        let url = self
            .url
            .ok_or_else(|| Error::new("request has no url"))?;
        let deadline = self.timeout.or(self.settings.timeout);

        let mut method = self.method;
        let mut body = self.body;
        let mut current = url;
        let mut previous: Vec<Url> = Vec::new();

        loop {
            let response = send_once(
                &method,
                &current,
                &self.headers,
                body.as_deref(),
                self.settings.connect_timeout,
                deadline,
            )
            .await?;

            let Some(location) = redirect_target(&response, &current) else {
                return Ok(response);
            };
            if !allow_redirect(&self.settings.redirect, &location, &previous) {
                return Ok(response);
            }

            // 303, and 301/302 on a non-GET, become a bodyless GET. This is
            // what every browser and `reqwest` do; the RFC's "should not" for
            // 301/302 lost to reality a long time ago.
            if response.status == StatusCode::SEE_OTHER
                || (matches!(
                    response.status,
                    StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND
                ) && !matches!(method, Method::Get | Method::Head))
            {
                method = Method::Get;
                body = None;
            }
            previous.push(std::mem::replace(&mut current, location));
        }
    }
}

fn redirect_target(response: &Response, base: &Url) -> Option<Url> {
    if !matches!(
        response.status,
        StatusCode::MOVED_PERMANENTLY
            | StatusCode::FOUND
            | StatusCode::SEE_OTHER
            | StatusCode::TEMPORARY_REDIRECT
            | StatusCode::PERMANENT_REDIRECT
    ) {
        return None;
    }
    let location = response.header_str("location")?;
    base.join(location).ok()
}

fn allow_redirect(policy: &redirect::Policy, next: &Url, previous: &[Url]) -> bool {
    match policy {
        redirect::Policy::Limited(max) => previous.len() < *max,
        redirect::Policy::Custom(f) => {
            f(redirect::Attempt {
                url: next.clone(),
                previous: previous.to_vec(),
            })
            .0
        }
    }
}

async fn send_once(
    method: &Method,
    url: &Url,
    headers: &[(String, Vec<u8>)],
    body: Option<&[u8]>,
    connect_timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
) -> Result<Response, Error> {
    let scheme = match url.scheme() {
        "https" => Scheme::Https,
        "http" => Scheme::Http,
        other => Scheme::Other(other.to_string()),
    };
    let host = url
        .host_str()
        .ok_or_else(|| Error::new(format!("url has no host: {url}")))?;
    let authority = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let path_with_query = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };

    let mut fields: Vec<(String, Vec<u8>)> = headers.to_vec();
    // Without this the host frames the request chunked, which a fair number of
    // provider gateways still reject on a POST.
    if let Some(body) = body {
        if !fields
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        {
            fields.push((
                "content-length".into(),
                body.len().to_string().into_bytes(),
            ));
        }
    }
    let headers = Fields::from_list(&fields)
        .map_err(|e| Error::new(format!("building request headers: {e:?}")))?;

    let request = OutgoingRequest::new(headers);
    request
        .set_method(method)
        .map_err(|()| Error::new(format!("unsupported method {method:?}")))?;
    request
        .set_scheme(Some(&scheme))
        .map_err(|()| Error::new(format!("unsupported scheme {:?}", url.scheme())))?;
    request
        .set_authority(Some(&authority))
        .map_err(|()| Error::new(format!("invalid authority {authority:?}")))?;
    request
        .set_path_with_query(Some(&path_with_query))
        .map_err(|()| Error::new(format!("invalid path {path_with_query:?}")))?;

    let options = RequestOptions::new();
    let idle = idle_timeout.unwrap_or(DEFAULT_IDLE_TIMEOUT);
    let _ = options.set_connect_timeout(connect_timeout.map(nanos));
    let _ = options.set_first_byte_timeout(Some(nanos(idle)));
    let _ = options.set_between_bytes_timeout(Some(nanos(idle)));

    // `body()` has to come out before `handle` takes the request.
    let outgoing_body = request
        .body()
        .map_err(|()| Error::new("request body already taken"))?;
    let future = outgoing_handler::handle(request, Some(options))
        .map_err(|e| Error::from_code("sending request", e))?;

    write_body(&outgoing_body, body.unwrap_or(&[])).await?;
    OutgoingBody::finish(outgoing_body, None)
        .map_err(|e| Error::from_code("finishing request body", e))?;

    let incoming = loop {
        match future.get() {
            Some(Ok(Ok(response))) => break response,
            Some(Ok(Err(e))) => return Err(Error::from_code("awaiting response", e)),
            Some(Err(())) => return Err(Error::new("response was already taken")),
            None => {
                let pollable = future.subscribe();
                wait(&pollable).await;
            }
        }
    };

    Response::new(incoming)
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

async fn write_body(body: &OutgoingBody, data: &[u8]) -> Result<(), Error> {
    let stream = body
        .write()
        .map_err(|()| Error::new("request body is already being written"))?;
    let mut offset = 0;
    while offset < data.len() {
        let permitted = match stream.check_write() {
            Ok(0) => {
                let pollable = stream.subscribe();
                wait(&pollable).await;
                continue;
            }
            Ok(n) => usize::try_from(n).unwrap_or(usize::MAX),
            Err(e) => return Err(stream_error("writing request body", e)),
        };
        let end = data.len().min(offset + permitted);
        stream
            .write(&data[offset..end])
            .map_err(|e| stream_error("writing request body", e))?;
        offset = end;
    }
    stream
        .flush()
        .map_err(|e| stream_error("flushing request body", e))?;
    {
        let pollable = stream.subscribe();
        wait(&pollable).await;
    }
    // The stream is a child of the body; it must go before `finish` runs.
    drop(stream);
    Ok(())
}

fn stream_error(context: &str, error: StreamError) -> Error {
    match error {
        StreamError::Closed => Error::new(format!("{context}: stream closed")),
        StreamError::LastOperationFailed(e) => {
            Error::new(format!("{context}: {}", e.to_debug_string()))
        }
    }
}

/// Response body resources, in drop order: the stream is a child of the body,
/// which is a child of the response.
struct Body {
    stream: Option<InputStream>,
    incoming: Option<IncomingBody>,
    response: Option<IncomingResponse>,
}

impl Body {
    fn close(&mut self) {
        self.stream = None;
        self.incoming = None;
        self.response = None;
    }

    async fn chunk(&mut self) -> Result<Option<Bytes>, Error> {
        loop {
            let Some(stream) = self.stream.as_ref() else {
                return Ok(None);
            };
            match stream.read(READ_CHUNK) {
                Ok(bytes) if bytes.is_empty() => {
                    let pollable = stream.subscribe();
                    wait(&pollable).await;
                }
                Ok(bytes) => return Ok(Some(Bytes::from(bytes))),
                Err(StreamError::Closed) => {
                    self.close();
                    return Ok(None);
                }
                Err(e) => {
                    let error = stream_error("reading response body", e);
                    self.close();
                    return Err(error);
                }
            }
        }
    }

    async fn to_end(&mut self) -> Result<Vec<u8>, Error> {
        let mut out = Vec::new();
        while let Some(chunk) = self.chunk().await? {
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }
}

pub struct Response {
    status: StatusCode,
    headers: Vec<(String, Vec<u8>)>,
    body: Body,
}

impl Response {
    fn new(incoming: IncomingResponse) -> Result<Self, Error> {
        let status = StatusCode::from_u16(incoming.status())
            .map_err(|e| Error::new(format!("invalid response status: {e}")))?;
        let headers = incoming.headers().entries();
        let body = incoming
            .consume()
            .map_err(|()| Error::new("response body was already consumed"))?;
        let stream = body
            .stream()
            .map_err(|()| Error::new("response body stream was already taken"))?;
        Ok(Response {
            status,
            headers,
            body: Body {
                stream: Some(stream),
                incoming: Some(body),
                response: Some(incoming),
            },
        })
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    fn header_str(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .and_then(|(_, value)| std::str::from_utf8(value).ok())
    }

    pub fn headers(&self) -> header::HeaderMap {
        let mut map = header::HeaderMap::new();
        for (name, value) in &self.headers {
            let Ok(name) = header::HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            let Ok(value) = header::HeaderValue::from_bytes(value) else {
                continue;
            };
            map.append(name, value);
        }
        map
    }

    pub fn content_length(&self) -> Option<u64> {
        self.header_str("content-length")?.parse().ok()
    }

    pub fn error_for_status(self) -> Result<Self, Error> {
        if self.status.is_client_error() || self.status.is_server_error() {
            return Err(Error {
                message: format!("HTTP status {}", self.status),
                timeout: false,
                status: Some(self.status),
            });
        }
        Ok(self)
    }

    pub async fn text(mut self) -> Result<String, Error> {
        let bytes = self.body.to_end().await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn bytes(mut self) -> Result<Bytes, Error> {
        Ok(Bytes::from(self.body.to_end().await?))
    }

    pub async fn json<T: serde::de::DeserializeOwned>(mut self) -> Result<T, Error> {
        let bytes = self.body.to_end().await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| Error::new(format!("decoding response body as json: {e}")))
    }

    pub async fn chunk(&mut self) -> Result<Option<Bytes>, Error> {
        self.body.chunk().await
    }

    /// Pinned on the way out: callers poll this with `StreamExt::next`, which
    /// wants `Unpin`, and `unfold`'s future is not.
    pub fn bytes_stream(self) -> impl Stream<Item = Result<Bytes, Error>> + Send + Unpin {
        Box::pin(futures_util::stream::unfold(Some(self.body), |state| async move {
            let mut body = state?;
            match body.chunk().await {
                Ok(Some(chunk)) => Some((Ok(chunk), Some(body))),
                Ok(None) => None,
                Err(e) => Some((Err(e), None)),
            }
        }))
    }
}

pub async fn get(url: impl IntoUrl) -> Result<Response, Error> {
    Client::new().get(url).send().await
}
