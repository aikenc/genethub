//! Probe guest for the v2 resident shell.
//!
//! Proves the §0.1 premise in-tree: a wasip2 `TcpListener` binds loopback and
//! answers HTTP. The product daemon is not this crate; wrapping it is later.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("guest TcpListener bind");
    let addr = listener.local_addr().expect("guest local_addr");
    println!("listening {addr}");
    loop {
        let (mut stream, _) = listener.accept().await.expect("guest accept");
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf).await;
            let body = b"ok\n";
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(body).await;
        });
    }
}
