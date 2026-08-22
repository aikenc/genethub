//! One WebSocket client, two targets.
//!
//! Fabric's wire is the same on a native build and inside the component; only
//! the act of opening the socket differs. Native hands the whole job to
//! `tokio-tungstenite`, which owns DNS, TCP and TLS. The guest has no such
//! thing to hand it to — `wasi:http` 0.2 has no WebSocket upgrade — so it
//! opens the socket through `wasi:sockets`, has the shell perform the TLS
//! handshake through `wasi:tls`, and gives tungstenite the resulting stream
//! for the part tungstenite is actually needed for: the HTTP upgrade and the
//! frame codec.
//!
//! Both paths therefore produce the same `WebSocketStream` over the same
//! codec, and every caller above this module is target-neutral. A second
//! implementation of the Fabric frame layer for the guest is precisely what
//! this exists to avoid.

use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Error;
use tokio_tungstenite::WebSocketStream;

#[cfg(not(target_family = "wasm"))]
pub type Transport = tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>;

#[cfg(target_family = "wasm")]
pub type Transport = guest::Transport;

/// What both halves return, so callers name one type.
pub type Socket = WebSocketStream<Transport>;

/// Opens a client WebSocket to `url`.
///
/// The error type is tungstenite's on both targets, which matters: the dialer
/// distinguishes "the relay said no" from "the relay did not answer" by
/// reading the HTTP status off `Error::Http`, and that has to keep working
/// when the socket underneath came from WASI.
#[cfg(not(target_family = "wasm"))]
pub async fn connect(url: &str, config: WebSocketConfig) -> Result<Socket, Error> {
    let request = url.into_client_request()?;
    let (socket, _) =
        tokio_tungstenite::connect_async_with_config(request, Some(config), false).await?;
    Ok(socket)
}

#[cfg(target_family = "wasm")]
pub async fn connect(url: &str, config: WebSocketConfig) -> Result<Socket, Error> {
    let request = url.into_client_request()?;
    tracing::debug!("guest opening the transport");
    let transport = guest::open(&request).await?;
    tracing::debug!("guest transport open; starting the WebSocket upgrade");
    let (socket, _) =
        tokio_tungstenite::client_async_with_config(request, transport, Some(config)).await?;
    Ok(socket)
}

#[cfg(target_family = "wasm")]
mod guest {
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use genet_wasi::net::TcpStream;
    use genet_wasi::tls::TlsStream;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio_tungstenite::tungstenite::handshake::client::Request;
    use tokio_tungstenite::tungstenite::Error;

    /// Whether the shell was asked to encrypt this connection. Loopback `ws://`
    /// is the only unencrypted case the Fabric URL check admits, and it is
    /// exactly the case where there is no network to protect it from.
    pub enum Transport {
        Plain(TcpStream),
        Tls(TlsStream),
    }

    pub async fn open(request: &Request) -> Result<Transport, Error> {
        let uri = request.uri();
        let host = uri
            .host()
            .ok_or_else(|| invalid("the Fabric endpoint URL has no host"))?
            // A bracketed IPv6 literal is the authority's syntax, not the
            // address; the socket layer wants the address.
            .trim_start_matches('[')
            .trim_end_matches(']');
        let tls = match uri.scheme_str() {
            Some("wss") => true,
            Some("ws") => false,
            other => {
                return Err(invalid(&format!(
                    "unsupported WebSocket scheme {}",
                    other.unwrap_or("(none)")
                )))
            }
        };
        let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
        if tls {
            Ok(Transport::Tls(
                TlsStream::connect(host, port, host).await.map_err(Error::Io)?,
            ))
        } else {
            Ok(Transport::Plain(
                TcpStream::connect(host, port).await.map_err(Error::Io)?,
            ))
        }
    }

    fn invalid(message: &str) -> Error {
        Error::Io(io::Error::new(io::ErrorKind::InvalidInput, message.to_string()))
    }

    impl AsyncRead for Transport {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Transport::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
                Transport::Tls(stream) => Pin::new(stream).poll_read(cx, buf),
            }
        }
    }

    impl AsyncWrite for Transport {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            match self.get_mut() {
                Transport::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
                Transport::Tls(stream) => Pin::new(stream).poll_write(cx, buf),
            }
        }

        fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Transport::Plain(stream) => Pin::new(stream).poll_flush(cx),
                Transport::Tls(stream) => Pin::new(stream).poll_flush(cx),
            }
        }

        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            match self.get_mut() {
                Transport::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
                Transport::Tls(stream) => Pin::new(stream).poll_shutdown(cx),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scheme check belongs to `validate_fabric_url`, but a URL that never
    /// reaches it must not fall through to a plaintext socket either.
    #[tokio::test]
    async fn refuses_a_scheme_that_is_not_websocket() {
        let error = connect("https://example.invalid/", WebSocketConfig::default())
            .await
            .expect_err("https is not a WebSocket URL");
        assert!(
            matches!(error, Error::Url(_)) || matches!(error, Error::Io(_)),
            "unexpected error for a non-WebSocket scheme: {error}"
        );
    }
}
