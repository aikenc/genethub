//! Outbound TCP for the guest, in `AsyncRead` / `AsyncWrite` shape.
//!
//! `tokio::net::TcpStream` exists on this target and works, but it owns the
//! socket and never hands back the underlying `input-stream` / `output-stream`.
//! `wasi:tls` needs exactly those two handles, so the one place that has to
//! layer TLS on top of a connection has to open the connection itself.
//!
//! Everything here obeys the rule the rest of this crate does: no import may
//! block. WASI sockets are non-blocking by contract and signal readiness
//! through a `pollable`, and `pollable.ready()` answers immediately — so every
//! wait is that probe plus the shared timer.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasi::io::streams::{InputStream, OutputStream, StreamError};
use wasi::sockets::instance_network::instance_network;
use wasi::sockets::ip_name_lookup::resolve_addresses;
use wasi::sockets::network::{
    ErrorCode, IpAddress, IpAddressFamily, IpSocketAddress, Ipv4SocketAddress, Ipv6SocketAddress,
};
use wasi::sockets::tcp::TcpSocket;
use wasi::sockets::tcp_create_socket::create_tcp_socket;

use crate::poll::{idle, Backoff};

/// The largest read asked for in one go. Matches `stdio`: big enough that a
/// busy socket is not read a syscall at a time, small enough that one read
/// cannot commit the instance to a huge allocation.
const CHUNK: u64 = 64 * 1024;

/// A connected TCP socket, plus the two byte streams it produced.
///
/// Field order is drop order. The streams are children of the socket in
/// Wasmtime's table; dropping the socket first traps with `resource has
/// children` and the host process exits. Keep the parent last.
pub struct TcpStream {
    input: InputStream,
    output: OutputStream,
    read_delay: Backoff,
    write_delay: Backoff,
    socket: TcpSocket,
}

impl TcpStream {
    /// Resolves `host`, connects to the first address that answers, and hands
    /// back the connection.
    ///
    /// Addresses are tried in the order the resolver returned them, which is
    /// its stated preference order; a machine on a network with broken IPv6
    /// therefore still reaches a dual-stack relay.
    pub async fn connect(host: &str, port: u16) -> io::Result<Self> {
        let addresses = resolve(host).await?;
        let mut last: Option<io::Error> = None;
        for address in addresses {
            match connect_to(address, port).await {
                Ok(stream) => return Ok(stream),
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{host} did not resolve to any address"),
            )
        }))
    }

    /// Splits into the raw WASI stream pair, giving up the ability to read and
    /// write through this type. The socket goes with them: whoever holds the
    /// streams is the one who needs the connection to stay open.
    pub fn into_parts(self) -> (TcpSocket, InputStream, OutputStream) {
        (self.socket, self.input, self.output)
    }
}

/// Turns a resolved address plus a port into a connected socket.
async fn connect_to(address: IpAddress, port: u16) -> io::Result<TcpStream> {
    let (family, remote) = match address {
        IpAddress::Ipv4(octets) => (
            IpAddressFamily::Ipv4,
            IpSocketAddress::Ipv4(Ipv4SocketAddress {
                port,
                address: octets,
            }),
        ),
        IpAddress::Ipv6(groups) => (
            IpAddressFamily::Ipv6,
            IpSocketAddress::Ipv6(Ipv6SocketAddress {
                port,
                flow_info: 0,
                address: groups,
                scope_id: 0,
            }),
        ),
    };
    let network = instance_network();
    let socket =
        create_tcp_socket(family).map_err(|error| socket_error("create a socket", error))?;
    socket
        .start_connect(&network, remote)
        .map_err(|error| socket_error("start connecting", error))?;
    let ready = socket.subscribe();
    loop {
        match socket.finish_connect() {
            Ok((input, output)) => {
                return Ok(TcpStream {
                    socket,
                    input,
                    output,
                    read_delay: Backoff::new(),
                    write_delay: Backoff::new(),
                })
            }
            Err(ErrorCode::WouldBlock) => {
                if !ready.ready() {
                    idle().await;
                }
            }
            Err(error) => return Err(socket_error("connect", error)),
        }
    }
}

/// DNS. A literal address is not sent to the resolver: `resolve-addresses` is
/// specified to accept one, but a build talking to a relay by IP should not
/// depend on the host having name lookup enabled at all.
async fn resolve(host: &str) -> io::Result<Vec<IpAddress>> {
    if let Some(literal) = parse_literal(host) {
        return Ok(vec![literal]);
    }
    let network = instance_network();
    let stream = resolve_addresses(&network, host)
        .map_err(|error| socket_error(&format!("resolve {host}"), error))?;
    let ready = stream.subscribe();
    let mut addresses = Vec::new();
    loop {
        match stream.resolve_next_address() {
            Ok(Some(address)) => addresses.push(address),
            Ok(None) => return Ok(addresses),
            Err(ErrorCode::WouldBlock) => {
                if !ready.ready() {
                    idle().await;
                }
            }
            Err(error) => return Err(socket_error(&format!("resolve {host}"), error)),
        }
    }
}

/// `"127.0.0.1"` and `"::1"`, without pulling in a parser that also accepts
/// host names. A bracketed IPv6 literal arrives here already unwrapped.
fn parse_literal(host: &str) -> Option<IpAddress> {
    match host.parse::<std::net::IpAddr>().ok()? {
        std::net::IpAddr::V4(address) => {
            let [a, b, c, d] = address.octets();
            Some(IpAddress::Ipv4((a, b, c, d)))
        }
        std::net::IpAddr::V6(address) => {
            let [a, b, c, d, e, f, g, h] = address.segments();
            Some(IpAddress::Ipv6((a, b, c, d, e, f, g, h)))
        }
    }
}

fn socket_error(context: &str, error: ErrorCode) -> io::Error {
    let kind = match error {
        ErrorCode::AccessDenied => io::ErrorKind::PermissionDenied,
        ErrorCode::ConnectionRefused => io::ErrorKind::ConnectionRefused,
        ErrorCode::ConnectionReset => io::ErrorKind::ConnectionReset,
        ErrorCode::ConnectionAborted => io::ErrorKind::ConnectionAborted,
        ErrorCode::Timeout => io::ErrorKind::TimedOut,
        ErrorCode::NameUnresolvable => io::ErrorKind::NotFound,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, format!("could not {context}: {error:?}"))
}

impl AsyncRead for TcpStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        Stream::poll_read_from(&me.input, &mut me.read_delay, cx, buf)
    }
}

impl AsyncWrite for TcpStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        Stream::poll_write_to(&me.output, &mut me.write_delay, cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(flush(&self.output))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(cx)
    }
}

/// The `AsyncRead` / `AsyncWrite` body shared by every WASI stream pair here,
/// so the TCP socket and the TLS connection above it cannot drift apart on
/// what "the stream had nothing yet" means.
pub(crate) struct Stream;

impl Stream {
    pub(crate) fn poll_read_from(
        input: &InputStream,
        delay: &mut Backoff,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if delay.waiting(cx) {
            return Poll::Pending;
        }
        let want = (buf.remaining() as u64).min(CHUNK);
        if want == 0 {
            return Poll::Ready(Ok(()));
        }
        match input.read(want) {
            // An untouched buffer is how `AsyncRead` spells EOF.
            Err(StreamError::Closed) => Poll::Ready(Ok(())),
            Err(error) => Poll::Ready(Err(stream_error("reading the connection", error))),
            Ok(chunk) if chunk.is_empty() => delay.idle(cx),
            Ok(chunk) => {
                buf.put_slice(&chunk);
                Poll::Ready(Ok(()))
            }
        }
    }

    pub(crate) fn poll_write_to(
        output: &OutputStream,
        delay: &mut Backoff,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if delay.waiting(cx) {
            return Poll::Pending;
        }
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        // `check-write` is the whole of the backpressure story: writing more
        // than it permits is a trap, not a short write.
        let permitted = match output.check_write() {
            Ok(0) => {
                // A zero permit is not always a backpressure signal. The
                // wasi:tls output stream advances its write/flush state
                // machine only when its pollable is queried or awaited, so
                // polling `check-write` alone never observes the completion
                // of an in-flight write and reports 0 forever. Querying the
                // pollable once drives that transition; only a genuine
                // not-ready falls back to the timer.
                let ready = output.subscribe();
                if ready.ready() {
                    cx.waker().wake_by_ref();
                    return Poll::Pending;
                }
                return delay.idle(cx);
            }
            Ok(available) => usize::try_from(available).unwrap_or(usize::MAX),
            Err(error) => return Poll::Ready(Err(stream_error("writing the connection", error))),
        };
        let end = buf.len().min(permitted);
        match output.write(&buf[..end]) {
            Ok(()) => Poll::Ready(Ok(end)),
            Err(error) => Poll::Ready(Err(stream_error("writing the connection", error))),
        }
    }
}

pub(crate) fn flush(output: &OutputStream) -> io::Result<()> {
    match output.flush() {
        Ok(()) => Ok(()),
        // Nothing left to flush into is not a flush failure.
        Err(StreamError::Closed) => Ok(()),
        Err(error) => Err(stream_error("flushing the connection", error)),
    }
}

pub(crate) fn stream_error(context: &str, error: StreamError) -> io::Error {
    match error {
        StreamError::Closed => io::Error::new(
            io::ErrorKind::BrokenPipe,
            format!("{context}: the peer closed the connection"),
        ),
        StreamError::LastOperationFailed(inner) => {
            io::Error::other(format!("{context}: {}", inner.to_debug_string()))
        }
    }
}
