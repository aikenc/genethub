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

/// Wasmtime 48's p2 handler clones owned request-options without deleting its
/// table entry. Consume that entry after delegation, on success and error.
/// Keep the normal types bindings and Hooks (including the Host header fix).
/// Remove this compatibility wrapper when upgrading to an upstream fix; the
/// ownership regression tests must continue to pass against that version.
pub fn add_http_to_linker(
    linker: &mut wasmtime::component::Linker<crate::load::Host>,
) -> wasmtime::Result<()> {
    use wasmtime_wasi_http::p2::bindings::{http, LinkOptions};
    use wasmtime_wasi_http::{WasiHttp, WasiHttpView};

    http::types::add_to_linker::<_, WasiHttp>(
        linker,
        &LinkOptions::default().into(),
        crate::load::Host::http,
    )?;
    // Register only this function ourselves. The generated outgoing-handler
    // Host trait requires every HTTP resource trait as a supertrait; using it
    // on our Host would duplicate all of Wasmtime's types implementation.
    // This name is the WASI HTTP WIT package shipped by Wasmtime 48.
    linker
        .instance("wasi:http/outgoing-handler@0.2.12")?
        .func_wrap(
            "handle",
            |mut store: wasmtime::StoreContextMut<'_, crate::load::Host>,
             (request, options): (
                wasmtime::component::Resource<wasmtime_wasi_http::p2::types::HostOutgoingRequest>,
                Option<wasmtime::component::Resource<RequestOptions>>,
            )| {
                let result: std::result::Result<_, http::types::ErrorCode> =
                    match handle_request(store.data_mut(), request, options) {
                        Ok(future) => Ok(future),
                        Err(error) => Err(error.downcast()?),
                    };
                Ok((result,))
            },
        )?;
    Ok(())
}

fn handle_request(
    host: &mut crate::load::Host,
    request: wasmtime::component::Resource<wasmtime_wasi_http::p2::types::HostOutgoingRequest>,
    options: Option<wasmtime::component::Resource<RequestOptions>>,
) -> wasmtime_wasi_http::p2::HttpResult<
    wasmtime::component::Resource<wasmtime_wasi_http::p2::types::HostFutureIncomingResponse>,
> {
    use wasmtime::component::Resource;
    use wasmtime_wasi_http::p2::bindings::http::outgoing_handler;
    use wasmtime_wasi_http::WasiHttpView;

    let options_rep = options.as_ref().map(Resource::rep);
    let result = outgoing_handler::Host::handle(&mut host.http(), request, options);
    if let Some(rep) = options_rep {
        let consumed = Resource::<RequestOptions>::new_own(rep);
        // Check the type before deleting: a dependency change must fail
        // visibly rather than remove a reused slot of a different type.
        host.table.get(&consumed)?;
        host.table.delete(consumed)?;
    }
    result
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use wasmtime::component::{Resource, ResourceTable};
    use wasmtime_wasi_http::p2::bindings::http::types;
    use wasmtime_wasi_http::p2::types::{HostFutureIncomingResponse, HostOutgoingRequest};
    use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpView};

    // Native-intrinsic: the owned Component handle and the Rust table entry
    // have distinct lifetimes. There is no faithful Node resource-table API.
    fn host() -> crate::load::Host {
        let mut table = ResourceTable::new();
        table.set_max_capacity(8);
        crate::load::Host {
            table,
            wasi: wasmtime_wasi::WasiCtxBuilder::new().build(),
            http: WasiHttpCtx::new(),
            http_hooks: Hooks,
            tls: wasmtime_wasi_tls::WasiTlsCtxBuilder::new().build(),
        }
    }

    fn new_request(host: &mut crate::load::Host, authority: &str) -> Resource<HostOutgoingRequest> {
        let fields = types::HostFields::new(&mut host.http()).unwrap();
        let request = types::HostOutgoingRequest::new(&mut host.http(), fields).unwrap();
        let value = host.table.get_mut(&request).unwrap();
        value.authority = Some(authority.into());
        value.path_with_query = Some("/ownership".into());
        value.scheme = Some(types::Scheme::Http);
        request
    }

    fn new_options(host: &mut crate::load::Host) -> Resource<RequestOptions> {
        host.table
            .push(RequestOptions {
                connect_timeout: Some(Duration::from_millis(100)),
                first_byte_timeout: Some(Duration::from_millis(250)),
                between_bytes_timeout: Some(Duration::from_millis(100)),
            })
            .unwrap()
    }

    #[tokio::test]
    async fn owned_options_release_on_sync_errors_and_cancellation() {
        let mut host = host();
        for index in 0..200 {
            let request = new_request(&mut host, "127.0.0.1:1");
            let value = host.table.get_mut(&request).unwrap();
            if index % 2 == 0 {
                value.method = types::Method::Other("invalid\nmethod".into());
            } else {
                value.scheme = Some(types::Scheme::Other("unsupported".into()));
            }
            let options = new_options(&mut host);
            assert!(handle_request(&mut host, request, Some(options)).is_err());
            assert!(host.table.is_empty());
        }
        for with_options in [true, false] {
            for _ in 0..200 {
                let request = new_request(&mut host, "127.0.0.1:1");
                let options = with_options.then(|| new_options(&mut host));
                let future = handle_request(&mut host, request, options).unwrap();
                assert_eq!(
                    host.table
                        .iter_mut()
                        .filter(|e| e.is::<RequestOptions>())
                        .count(),
                    0
                );
                drop(host.table.delete(future).unwrap());
                assert!(host.table.is_empty());
            }
        }
    }

    #[tokio::test]
    async fn owned_options_release_with_real_http_and_preserve_timeout_and_host_header() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let authority = listener.local_addr().unwrap().to_string();
        let expected_host = authority.clone();
        let server = tokio::spawn(async move {
            for _ in 0..200 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut received = Vec::new();
                while !received.ends_with(b"\r\n\r\n") {
                    received.push(socket.read_u8().await.unwrap());
                }
                let headers = String::from_utf8(received).unwrap().to_lowercase();
                assert!(headers.contains(&format!("\r\nhost: {expected_host}\r\n")));
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await
                    .unwrap();
            }
        });
        let mut host = host();
        for _ in 0..200 {
            let request = new_request(&mut host, &authority);
            let options = new_options(&mut host);
            let future = handle_request(&mut host, request, Some(options)).unwrap();
            assert_eq!(
                host.table
                    .iter_mut()
                    .filter(|e| e.is::<RequestOptions>())
                    .count(),
                0
            );
            let HostFutureIncomingResponse::Pending(pending) = host.table.delete(future).unwrap()
            else {
                panic!("new future is not pending")
            };
            let (response, worker) = tokio::time::timeout(Duration::from_secs(2), pending)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(response.status(), http::StatusCode::OK);
            drop((response, worker));
            assert!(host.table.is_empty());
        }
        server.await.unwrap();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let request = new_request(&mut host, &listener.local_addr().unwrap().to_string());
        let options = new_options(&mut host);
        let future = handle_request(&mut host, request, Some(options)).unwrap();
        let HostFutureIncomingResponse::Pending(pending) = host.table.delete(future).unwrap()
        else {
            panic!("new future is not pending")
        };
        // TCP succeeds but the listener never sends a first byte. If options
        // were lost, Wasmtime's default wait would exceed this 2s outer bound.
        assert!(tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .unwrap()
            .is_err());
        assert!(host.table.is_empty());
        drop(listener);

        let request = new_request(&mut host, &authority); // closed listener
        let options = new_options(&mut host);
        let future = handle_request(&mut host, request, Some(options)).unwrap();
        let HostFutureIncomingResponse::Pending(pending) = host.table.delete(future).unwrap()
        else {
            panic!("new future is not pending")
        };
        assert!(tokio::time::timeout(Duration::from_secs(2), pending)
            .await
            .unwrap()
            .is_err());
        assert!(host.table.is_empty());
    }
}
