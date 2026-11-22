//! Nonblocking, loopback-only server TLS. No HTTP or application policy.

use std::future::Future;
use std::net::Ipv4Addr;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use rustls::pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::server::{Accept, TlsStream};
use tokio_rustls::TlsAcceptor;
use wasmtime::component::Resource;

use crate::bindings::genehub::host::tls_server as wit;
use crate::load::Host;

const MAX_CHUNK: usize = 128 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Listener {
    listener: TcpListener,
    acceptor: TlsAcceptor,
    port: u16,
}

pub enum Connection {
    Negotiating(Pin<Box<tokio::time::Timeout<Accept<TcpStream>>>>),
    Open(Box<TlsStream<TcpStream>>),
    Closed,
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

impl Connection {
    fn stream(&mut self) -> Result<Pin<&mut TlsStream<TcpStream>>, String> {
        match self {
            Self::Open(stream) => Ok(Pin::new(stream)),
            _ => Err("TLS stream is unopened".into()),
        }
    }
}

impl wit::Host for Host {
    async fn transfer(
        &mut self,
        connection: Resource<Connection>,
        target: u64,
    ) -> Result<(), String> {
        let connection = self.table.delete(connection).map_err(error)?;
        if !matches!(connection, Connection::Open(_)) {
            return Err("TLS handshake is incomplete".into());
        }
        self.worker.transfer(target, connection)
    }

    async fn receive(&mut self) -> Result<Option<Resource<Connection>>, String> {
        let Some(connection) = self.worker.accept_transfer()? else {
            return Ok(None);
        };
        self.table.push(connection).map(Some).map_err(error)
    }

    async fn listen_loopback(
        &mut self,
        cert: String,
        key: String,
    ) -> Result<Resource<Listener>, String> {
        if matches!(self.worker, crate::worker::State::Disabled) {
            return Err("TLS listener requires a daemon instance".into());
        }
        let cert = crate::guest_paths::host_path_from_guest(cert);
        let key = crate::guest_paths::host_path_from_guest(key);
        let chain = CertificateDer::pem_file_iter(cert)
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?;
        let key = PrivateKeyDer::from_pem_file(key).map_err(error)?;
        let mut config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(error)?
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .map_err(error)?;
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(error)?;
        let port = listener.local_addr().map_err(error)?.port();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        self.table
            .push(Listener {
                listener,
                acceptor,
                port,
            })
            .map_err(error)
    }
}

impl wit::HostListener for Host {
    async fn port(&mut self, listener: Resource<Listener>) -> u16 {
        self.table
            .get(&listener)
            .map_or(0, |listener| listener.port)
    }

    async fn accept(
        &mut self,
        listener: Resource<Listener>,
    ) -> Result<Option<Resource<Connection>>, String> {
        let listener = self.table.get(&listener).map_err(error)?;
        let mut context = Context::from_waker(Waker::noop());
        let (socket, _) = match listener.listener.poll_accept(&mut context) {
            Poll::Pending => return Ok(None),
            Poll::Ready(result) => result.map_err(error)?,
        };
        socket.set_nodelay(true).map_err(error)?;
        let handshake = listener.acceptor.accept(socket);
        let connection =
            Connection::Negotiating(Box::pin(tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake)));
        self.table.push(connection).map(Some).map_err(error)
    }

    async fn drop(&mut self, listener: Resource<Listener>) -> wasmtime::Result<()> {
        self.table.delete(listener)?;
        Ok(())
    }
}

impl wit::HostConnection for Host {
    async fn poll_server_name(
        &mut self,
        connection: Resource<Connection>,
    ) -> Result<Option<String>, String> {
        let connection = self.table.get_mut(&connection).map_err(error)?;
        if let Connection::Negotiating(handshake) = connection {
            let mut context = Context::from_waker(Waker::noop());
            match handshake.as_mut().poll(&mut context) {
                Poll::Pending => return Ok(None),
                Poll::Ready(Ok(Ok(stream))) => *connection = Connection::Open(Box::new(stream)),
                Poll::Ready(_) => {
                    *connection = Connection::Closed;
                    return Err("server TLS handshake failed".into());
                }
            }
        }
        connection
            .stream()?
            .as_ref()
            .get_ref()
            .get_ref()
            .1
            .server_name()
            .map(|host| Some(host.to_ascii_lowercase()))
            .ok_or_else(|| "TLS server name required".into())
    }

    async fn read(
        &mut self,
        connection: Resource<Connection>,
        max_bytes: u32,
    ) -> Result<wit::ReadResult, String> {
        let stream = self.table.get_mut(&connection).map_err(error)?.stream()?;
        let mut bytes = vec![0; (max_bytes as usize).min(MAX_CHUNK)];
        let mut buffer = ReadBuf::new(&mut bytes);
        let mut context = Context::from_waker(Waker::noop());
        match stream.poll_read(&mut context, &mut buffer) {
            Poll::Pending => Ok(wit::ReadResult::Pending),
            Poll::Ready(Ok(())) if buffer.filled().is_empty() => Ok(wit::ReadResult::Closed),
            Poll::Ready(Ok(())) => {
                let length = buffer.filled().len();
                bytes.truncate(length);
                Ok(wit::ReadResult::Data(bytes))
            }
            Poll::Ready(Err(err)) => Err(error(err)),
        }
    }

    async fn write(
        &mut self,
        connection: Resource<Connection>,
        bytes: Vec<u8>,
    ) -> Result<u32, String> {
        let stream = self.table.get_mut(&connection).map_err(error)?.stream()?;
        let mut context = Context::from_waker(Waker::noop());
        match stream.poll_write(&mut context, &bytes[..bytes.len().min(MAX_CHUNK)]) {
            Poll::Pending => Ok(0),
            Poll::Ready(result) => result.map(|length| length as u32).map_err(error),
        }
    }

    async fn flush(&mut self, connection: Resource<Connection>) -> Result<bool, String> {
        let stream = self.table.get_mut(&connection).map_err(error)?.stream()?;
        let mut context = Context::from_waker(Waker::noop());
        match stream.poll_flush(&mut context) {
            Poll::Pending => Ok(false),
            Poll::Ready(result) => result.map(|()| true).map_err(error),
        }
    }

    async fn shutdown(&mut self, connection: Resource<Connection>) -> Result<bool, String> {
        let stream = self.table.get_mut(&connection).map_err(error)?.stream()?;
        let mut context = Context::from_waker(Waker::noop());
        match stream.poll_shutdown(&mut context) {
            Poll::Pending => Ok(false),
            Poll::Ready(result) => result.map(|()| true).map_err(error),
        }
    }

    async fn drop(&mut self, connection: Resource<Connection>) -> wasmtime::Result<()> {
        self.table.delete(connection)?;
        Ok(())
    }
}
