//! Client TLS over `wasi:tls`, in `AsyncRead` / `AsyncWrite` shape.
//!
//! The guest never sees a certificate, a root store or a cipher suite. It
//! hands the shell a server name and the two byte streams of a connected
//! socket, and gets back two byte streams that happen to be encrypted. That
//! split is the whole point: the cryptography stays in the host, where it is
//! one audited rustls, and the component stays free of a crypto provider it
//! would have to keep current on its own.
//!
//! `wasi:tls@0.2.0-draft` is a standard WASI import, not another private ABI
//! the shell had to grow. It is Phase 1 in the WASI process, which is why the
//! WIT is vendored next to this file rather than pulled from a released
//! bindings crate.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasi::io::streams::{InputStream, OutputStream};
use wasi::sockets::tcp::TcpSocket;

use crate::net::{self, Stream, TcpStream};
use crate::poll::{idle, Backoff};

mod bindings {
    //! Only `wasi:tls/types` is generated here. The `wasi:io` interfaces it
    //! refers to are the ones the rest of the guest already uses, so the
    //! streams a socket produced can be handed straight to the handshake
    //! instead of being copied through a second, incompatible set of types.
    wit_bindgen::generate!({
        path: "wit/tls",
        world: "imports",
        features: ["tls"],
        with: {
            "wasi:io/error@0.2.12": ::wasi::io::error,
            "wasi:io/poll@0.2.12": ::wasi::io::poll,
            "wasi:io/streams@0.2.12": ::wasi::io::streams,
        },
    });
}

use bindings::wasi::tls::types::{ClientConnection, ClientHandshake};

/// An established TLS client connection.
///
/// Field order is drop order. Encrypted streams are children of the TLS
/// connection, and the connection sits on the TCP socket; dropping a parent
/// first traps with `resource has children` and the host process exits.
pub struct TlsStream {
    input: InputStream,
    output: OutputStream,
    read_delay: Backoff,
    write_delay: Backoff,
    _connection: ClientConnection,
    _socket: TcpSocket,
}

impl TlsStream {
    /// Connects to `host:port` and completes a client handshake for
    /// `server_name`.
    ///
    /// `server_name` is passed separately from the address on purpose: it is
    /// what the certificate is checked against, and a caller that has already
    /// resolved a relay to an IP still has to say which name it expected to
    /// reach.
    pub async fn connect(host: &str, port: u16, server_name: &str) -> io::Result<Self> {
        let transport = TcpStream::connect(host, port).await?;
        Self::handshake(transport, server_name).await
    }

    /// The same handshake over a socket the caller already has.
    pub async fn handshake(transport: TcpStream, server_name: &str) -> io::Result<Self> {
        let (socket, plain_input, plain_output) = transport.into_parts();
        let handshake = ClientHandshake::new(server_name, plain_input, plain_output);
        let pending = ClientHandshake::finish(handshake);
        let ready = pending.subscribe();
        let (connection, input, output) = loop {
            match pending.get() {
                None => {
                    if !ready.ready() {
                        idle().await;
                    }
                }
                // The handshake future is single-shot; `get` answering twice
                // would be a host bug, and there is nothing useful to retry.
                Some(Err(())) => {
                    return Err(io::Error::other(
                        "the TLS handshake result was already taken",
                    ))
                }
                Some(Ok(Err(error))) => {
                    return Err(io::Error::other(format!(
                        "TLS handshake with {server_name} failed: {}",
                        error.to_debug_string()
                    )))
                }
                Some(Ok(Ok(streams))) => break streams,
            }
        };
        Ok(Self {
            _connection: connection,
            _socket: socket,
            input,
            output,
            read_delay: Backoff::new(),
            write_delay: Backoff::new(),
        })
    }
}

impl AsyncRead for TlsStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        Stream::poll_read_from(&me.input, &mut me.read_delay, cx, buf)
    }
}

impl AsyncWrite for TlsStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        Stream::poll_write_to(&me.output, &mut me.write_delay, cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(net::flush(&self.output))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(cx)
    }
}
