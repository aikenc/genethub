//! Outbound HTTP policy for the guest.
//!
//! One correction to the default: `wasi:http` names the destination as a
//! separate `authority` rather than a header, and Wasmtime's p2 outgoing path
//! never turns that back into `Host` — it only does so on the p3 path. An
//! HTTP/1.1 request without `Host` is malformed, and real gateways say so:
//! api.deepseek.com answers `418 I'm a Teapot` and nothing else.
//!
//! The guest cannot fix this itself. `Host` is a forbidden header, stripped on
//! the way out, which is the right call — a guest that could name a host other
//! than the one being dialled could front one origin behind another. So the
//! shell fills it in, from the authority it is actually connecting to.

use std::future::Future;

use http::header::HOST;
use http::HeaderValue;
use wasmtime_wasi_http::{Error, RequestOptions, Result, WasiBody, WasiHttpHooks};

#[derive(Default)]
pub struct Hooks;

impl WasiHttpHooks for Hooks {
    fn send_request(
        &mut self,
        mut request: http::Request<WasiBody>,
        options: Option<RequestOptions>,
        fut: Box<dyn Future<Output = Result<(), Error>> + Send>,
    ) -> Box<
        dyn Future<
                Output = Result<(
                    http::Response<WasiBody>,
                    Box<dyn Future<Output = Result<(), Error>> + Send>,
                )>,
            > + Send,
    > {
        let _ = fut;
        if let Some(authority) = request.uri().authority() {
            if let Ok(value) = HeaderValue::try_from(authority.as_str()) {
                request.headers_mut().insert(HOST, value);
            }
        }
        Box::new(async move {
            use http_body_util::BodyExt;

            let (response, io) = wasmtime_wasi_http::default_send_request(request, options).await?;
            Ok((
                response.map(BodyExt::boxed_unsync),
                Box::new(io) as Box<dyn Future<Output = _> + Send>,
            ))
        })
    }
}
