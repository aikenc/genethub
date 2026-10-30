//! Existing Preview v1 loopback wire: HMAC run proof, HTTP and WS packets.
//! No new broker/Exchange, and no client-supplied principal is trusted.
use crate::{
    media::{Media, Offer},
    state::{App, View},
};
use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{broadcast, mpsc, oneshot, Semaphore},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        protocol::WebSocketConfig,
        Message,
    },
    WebSocketStream,
};
const LIMIT: usize = 256 * 1024;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn sign(secret: &str, text: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC key");
    mac.update(text.as_bytes());
    hex(&mac.finalize().into_bytes())
}
fn verify(secret: &str, text: &str, proof: &str) -> Result<()> {
    if proof.len() != 64 || !proof.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("invalid client proof");
    }
    let raw = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&proof[i..i + 2], 16))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(text.as_bytes());
    mac.verify_slice(&raw)
        .map_err(|_| anyhow!("invalid client proof"))
}
fn json_packet(value: Value) -> Result<Vec<u8>> {
    let mut packet = vec![0];
    packet.extend(serde_json::to_vec(&value)?);
    if packet.len() > LIMIT {
        bail!("packet too large");
    }
    Ok(packet)
}
async fn raw(socket: &mut WebSocketStream<TcpStream>) -> Result<Vec<u8>> {
    loop {
        match socket.next().await.context("bridge closed")?? {
            Message::Binary(bytes) if !bytes.is_empty() && bytes.len() <= LIMIT => {
                return Ok(bytes)
            }
            Message::Ping(_) | Message::Pong(_) => {}
            _ => bail!("invalid bridge packet"),
        }
    }
}
struct Out {
    packet: Vec<u8>,
    done: oneshot::Sender<Result<()>>,
}
struct Bridge {
    input: mpsc::Receiver<Vec<u8>>,
    output: mpsc::Sender<Out>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}
impl Bridge {
    async fn accept(stream: TcpStream, secret: &str, run: &str) -> Result<Self> {
        let check = |request: &Request,
                     response: Response|
         -> std::result::Result<Response, ErrorResponse> {
            if request.headers().contains_key("origin") {
                return Err(tokio_tungstenite::tungstenite::http::Response::builder()
                    .status(403)
                    .body(Some("origin denied".into()))
                    .unwrap());
            }
            Ok(response)
        };
        let mut socket = accept_hdr_async_with_config(
            stream,
            check,
            Some(WebSocketConfig {
                max_message_size: Some(LIMIT),
                max_frame_size: Some(LIMIT),
                ..Default::default()
            }),
        )
        .await?;
        tokio::time::timeout(Duration::from_secs(5), async {
            let first = raw(&mut socket).await?;
            if first[0] != 0 {
                bail!("proof required");
            }
            let value: Value = serde_json::from_slice(&first[1..])?;
            let nonce = value["nonce"].as_str().context("nonce required")?;
            if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
                bail!("invalid nonce");
            }
            socket
                .send(Message::Binary(json_packet(
                    json!({"proof":sign(secret,&format!("server:{nonce}:{run}"))}),
                )?))
                .await?;
            let proof = raw(&mut socket).await?;
            if proof[0] != 0 {
                bail!("proof required");
            }
            let answer: Value = serde_json::from_slice(&proof[1..])?;
            verify(
                secret,
                &format!("client:{nonce}:{run}"),
                answer["proof"].as_str().context("client proof missing")?,
            )?;
            socket
                .send(Message::Binary(json_packet(json!({"kind":"ready"}))?))
                .await?;
            Result::<()>::Ok(())
        })
        .await??;
        let (mut sink, mut source) = socket.split();
        let (tx, input) = mpsc::channel(16);
        let (output, mut rx) = mpsc::channel::<Out>(8);
        let (ack_tx, mut ack_rx) = mpsc::channel::<()>(1);
        let reader = tokio::spawn(async move {
            while let Some(Ok(message)) = source.next().await {
                match message {
                    Message::Binary(packet) if !packet.is_empty() && packet.len() <= LIMIT => {
                        if packet == [2] {
                            let _ = ack_tx.try_send(());
                        } else if tx.try_send(packet).is_err() {
                            break;
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    _ => break,
                }
            }
        });
        let writer = tokio::spawn(async move {
            while let Some(out) = rx.recv().await {
                while ack_rx.try_recv().is_ok() {}
                let result = tokio::time::timeout(Duration::from_secs(30), async {
                    sink.send(Message::Binary(out.packet)).await?;
                    ack_rx
                        .recv()
                        .await
                        .context("bridge closed before consumption")?;
                    Result::<()>::Ok(())
                })
                .await
                .map_err(|_| anyhow!("bridge consumer timeout"))
                .and_then(|r| r);
                let failed = result.is_err();
                let _ = out.done.send(result);
                if failed {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        Ok(Self {
            input,
            output,
            tasks: vec![reader, writer],
        })
    }
    async fn recv(&mut self) -> Result<Vec<u8>> {
        self.input.recv().await.context("bridge closed")
    }
    async fn send(&self, packet: Vec<u8>) -> Result<()> {
        if packet.is_empty() || packet.len() > LIMIT {
            bail!("packet limit");
        }
        let (done, wait) = oneshot::channel();
        self.output
            .try_send(Out { packet, done })
            .map_err(|_| anyhow!("bridge output full"))?;
        wait.await.context("bridge output closed")?
    }
    async fn json(&self, value: Value) -> Result<()> {
        self.send(json_packet(value)?).await
    }
    async fn text(&self, value: Value) -> Result<()> {
        self.json(json!({"kind":"text","text":serde_json::to_string(&value)?}))
            .await
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

pub struct Registration {
    path: PathBuf,
    digest: String,
    receipt_path: PathBuf,
}
// Owner receipts are lifecycle evidence, not a new network permission. Capture
// holds the existing per-account instance lock throughout publish and Drop, so
// a receipt-matching previous Capture cannot still own that account lock.
fn registration_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    use genet_frontdoor::perms::*;
    let metadata = match sensitive_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_file() || metadata.len() > 16384 {
        bail!("invalid Capture ownership record");
    }
    Ok(Some(std::fs::read(path)?))
}
fn receipt_matches(path: &Path, registration: &Path, digest: &str) -> Result<bool> {
    let Some(bytes) = registration_bytes(path)? else {
        return Ok(false);
    };
    let value: Value =
        serde_json::from_slice(&bytes).context("invalid Capture ownership receipt")?;
    Ok(value == json!({"version":1,"registration":registration,"sha256":digest}))
}
impl Registration {
    pub fn publish(
        root: &Path,
        entry: &Path,
        port: u16,
        run_id: &str,
        secret: &str,
    ) -> Result<Self> {
        use genet_frontdoor::perms::*;
        let root = root
            .canonicalize()
            .context("--daemon-root must be the actual daemon data directory")?;
        let entry = entry.canonicalize().context("entry HTML missing")?;
        if !entry.is_file() || !entry.extension().is_some_and(|x| x == "html" || x == "htm") {
            bail!("entry must be an existing HTML file");
        }
        let identity = entry.to_string_lossy().into_owned();
        #[cfg(windows)]
        let identity = identity
            .strip_prefix(r"\\?\")
            .unwrap_or(&identity)
            .replace('\\', "/");
        let directory = root.join("service-previews");
        ensure_real_directory(&directory)?;
        restrict_dir_to_owner(&directory)?;
        let path = directory.join(format!(
            "{}.json",
            hex(&Sha256::digest(identity.as_bytes()))
        ));
        let receipts = dirs::data_local_dir()
            .context("local app data directory unavailable")?
            .join("GeneHubCapture/registrations");
        ensure_real_directory(&receipts)?;
        restrict_dir_to_owner(&receipts)?;
        let receipt_path = receipts.join(format!(
            "{}.json",
            hex(&Sha256::digest(path.to_string_lossy().as_bytes()))
        ));
        if let Some(previous) = registration_bytes(&path)? {
            let digest = hex(&Sha256::digest(&previous));
            if !receipt_matches(&receipt_path, &path, &digest)? {
                bail!("entry already registered; its contents are not owned by this Capture installation");
            }
            // Only exact bytes previously published by this account's Capture
            // are reclaimed. Name/protocol/PID/runId alone are not ownership.
            std::fs::remove_file(&path)?;
        }
        let value = json!({"version":1,"pid":std::process::id(),"control":false,"entry":identity,"runId":run_id,"secret":secret,"port":port,"name":"Capture",
            "routes":[{"prefix":"/api/remote/","websocket":true}],"media":{"offerPath":"/api/remote/offer","stopPath":"/api/remote/stop","microphone":"none","client":"html","protocol":"remote-desktop/1","sessionPath":"/api/remote/session","controlPath":"/api/remote/control"},"iceServers":[],"dataPolicy":"auto"});
        let bytes = serde_json::to_vec(&value)?;
        if bytes.len() > 16384 {
            bail!("registration too large");
        }
        let temporary = directory.join(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
        let file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        restrict_to_owner(&temporary)?;
        use std::io::Write;
        let mut file = file;
        file.write_all(&bytes)?;
        file.sync_all()?;
        let digest = hex(&Sha256::digest(&bytes));
        let receipt =
            serde_json::to_vec(&json!({"version":1,"registration":path,"sha256":digest}))?;
        let staged_receipt = receipts.join(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
        let receipt_result: Result<()> = (|| {
            // Inspect any old receipt before atomic replacement; never follow
            // a link/reparse point in the account's private lifecycle data.
            let _ = registration_bytes(&receipt_path)?;
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&staged_receipt)?;
            restrict_to_owner(&staged_receipt)?;
            file.write_all(&receipt)?;
            file.sync_all()?;
            replace_private(&staged_receipt, &receipt_path)?;
            Ok(())
        })();
        if let Err(error) = receipt_result {
            let _ = std::fs::remove_file(&staged_receipt);
            let _ = std::fs::remove_file(&temporary);
            return Err(error);
        }
        // Receipt first: a crash immediately after publication remains
        // recoverable. Failed no-clobber publication cannot claim a foreign
        // registration because its bytes will not match this receipt.
        // Atomic no-clobber publication: a concurrent publisher must not have
        // its run replaced between our initial check and publication.
        if let Err(error) = std::fs::hard_link(&temporary, &path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.into());
        }
        std::fs::remove_file(&temporary)?;
        Ok(Self {
            path,
            digest,
            receipt_path,
        })
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        if registration_bytes(&self.path)
            .ok()
            .flatten()
            .is_some_and(|bytes| hex(&Sha256::digest(&bytes)) == self.digest)
            && std::fs::remove_file(&self.path).is_ok()
            && receipt_matches(&self.receipt_path, &self.path, &self.digest).unwrap_or(false)
        {
            let _ = std::fs::remove_file(&self.receipt_path);
        }
    }
}

fn path(value: &Value) -> Result<&str> {
    let path = value["path"].as_str().context("path required")?;
    if !path.starts_with("/api/remote/")
        || path.len() > 256
        || path.bytes().any(|b| b < 32 || b"%\\?#".contains(&b))
        || path.split('/').any(|p| p == "." || p == "..")
    {
        bail!("path denied");
    }
    Ok(path)
}
async fn reply(bridge: &Bridge, status: u16, value: Value) -> Result<()> {
    let body = serde_json::to_vec(&value)?;
    if body.len() > 192 * 1024 {
        bail!("response too large");
    }
    bridge.json(json!({"kind":"head","status":status,"headers":{"content-type":"application/json","cache-control":"no-store"}})).await?;
    for chunk in body.chunks(32768) {
        let mut packet = vec![1];
        packet.extend(chunk);
        bridge.send(packet).await?;
    }
    bridge.json(json!({"kind":"end"})).await
}
async fn handle_http(bridge: &mut Bridge, app: &Arc<App>, operation: Value) -> Result<()> {
    let path = path(&operation)?.to_owned();
    let method = operation["method"].as_str().unwrap_or("");
    let mut body = Vec::new();
    loop {
        let packet = bridge.recv().await?;
        if packet[0] == 0 && serde_json::from_slice::<Value>(&packet[1..])?["kind"] == "end" {
            break;
        }
        if packet[0] != 1 || body.len() + packet.len() - 1 > 192 * 1024 {
            bail!("request too large");
        }
        body.extend(&packet[1..]);
    }
    let result: Result<Value> = async {
        match (method, path.as_str()) {
            ("GET", "/api/remote/state") => Ok(app.status().await),
            ("POST", "/api/remote/offer") => {
                let offer: Offer = serde_json::from_slice(&body)?;
                let view = app.session(&offer.session_id, &offer.session_token).await?;
                let mut current = view.media.lock().await;
                if current.is_some() {
                    bail!("offer_already_set");
                }
                let (media, answer) =
                    Media::open(&view, app.engine.clone(), app.config, offer).await?;
                if view.closing.load(std::sync::atomic::Ordering::SeqCst) {
                    media.close().await;
                    bail!("session_expired");
                }
                *current = Some(media);
                Ok(answer)
            }
            ("POST", "/api/remote/stop") => {
                let value: Value = serde_json::from_slice(&body)?;
                let control_state=app.stop(
                    required(&value, "sessionId")?,
                    required(&value, "sessionToken")?,
                )
                .await?;
                Ok(json!({"state":if control_state=="release-pending"{"closing"}else{"closed"},"controlState":control_state}))
            }
            _ => bail!("route_not_found"),
        }
    }
    .await;
    match result {
        Ok(value) => reply(bridge, 200, value).await,
        Err(error) => {
            let code = error.to_string();
            let status = if code == "route_not_found" {
                404
            } else if code == "session_expired" {
                410
            } else {
                409
            };
            // Diagnostic text remains local; never echo SDP, paths, tokens or OS errors.
            let public = if ["route_not_found", "session_expired", "offer_already_set"]
                .contains(&code.as_str())
            {
                code.as_str()
            } else {
                "media_unavailable"
            };
            reply(bridge, status, json!({"error":{"code":public}})).await
        }
    }
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| anyhow!("missing or invalid field"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Rpc {
    #[serde(default)]
    id: Option<String>,
    method: String,
    #[serde(default)]
    params: Value,
}
struct Anchor {
    view: Arc<View>,
    control_owner: Option<String>,
}
impl Anchor {
    async fn close(&self) {
        if let Some(owner) = &self.control_owner {
            let _ = self.view.release_control(Some(owner)).await;
        } else {
            self.view.close("view_ws_closed").await;
        }
    }
}
impl Drop for Anchor {
    fn drop(&mut self) {
        let view = self.view.clone();
        let owner = self.control_owner.clone();
        tokio::spawn(async move {
            if let Some(owner) = owner {
                let _ = view.release_control(Some(&owner)).await;
            } else {
                view.close("view_ws_dropped").await;
            }
        });
    }
}
async fn event(receiver: &mut Option<broadcast::Receiver<Value>>) -> Result<Value> {
    match receiver {
        Some(receiver) => receiver
            .recv()
            .await
            .map_err(|_| anyhow!("event stream ended or overflowed")),
        None => std::future::pending().await,
    }
}
async fn handle_ws(bridge: &mut Bridge, app: &Arc<App>, operation: Value) -> Result<()> {
    let started_at = Instant::now();
    let path = path(&operation)?;
    let control = match path {
        "/api/remote/session" => false,
        "/api/remote/control" => true,
        _ => bail!("route_not_found"),
    };
    bridge.json(json!({"kind":"open"})).await?;
    let owner = uuid::Uuid::new_v4().simple().to_string();
    let mut anchor: Option<Anchor> = None;
    let mut events = None;
    let mut nonce = uuid::Uuid::new_v4().simple().to_string();
    let mut consumed = false;
    let mut last_consumed = None;
    let mut renewals = 0u32;
    let mut anchored_renewals = 0u32;
    let mut challenges = 0u32;
    let mut deadline = Instant::now() + Duration::from_secs(3);
    let mut timer = tokio::time::interval(Duration::from_secs(1));
    let mut rate = (Instant::now(), 0u32);
    let mut cache: HashMap<String, (Vec<u8>, Value)> = HashMap::new();
    let mut order = VecDeque::new();
    let outcome:Result<()>=async{loop{
        if Instant::now()>=deadline{bail!("session_expired");}
        tokio::select!{
            _=timer.tick()=>{
                if consumed{nonce=uuid::Uuid::new_v4().simple().to_string();consumed=false;}
                bridge.text(json!({"event":"challenge","params":{"nonce":nonce}})).await?;
                challenges+=1;
            },
            value=event(&mut events)=>{
                let value=value?;let closed=value["event"]=="session.closed";
                bridge.text(value).await?;if closed{break;}
            },
            packet=bridge.recv()=>{
                let packet=packet?;if packet[0]!=0||packet.len()>20000{bail!("invalid WS application packet");}
                let outer:Value=serde_json::from_slice(&packet[1..])?;
                if outer["kind"]=="close"{break;}
                if outer["kind"]!="text"{bail!("expected WS text");}
                let text=outer["text"].as_str().context("WS text missing")?;let request:Rpc=serde_json::from_str(text)?;
                if request.method.len()>64||request.id.as_ref().is_some_and(|s|s.is_empty()||s.len()>64){bail!("invalid request");}
                if rate.0.elapsed()>=Duration::from_secs(1){rate=(Instant::now(),0);}rate.1+=1;if rate.1>20{bail!("request_rate_exceeded");}
                if request.method=="renew"{
                    // A retransmitted answer never extends authority. The
                    // server may have repeated its nonce before the first
                    // answer arrived; tolerate that duplicate on this WS.
                    if last_consumed.as_ref().is_some_and(|n|request.params["nonce"]==*n){continue;}
                    if consumed||Instant::now()>=deadline||request.params["nonce"]!=nonce{bail!("expired_challenge");}
                    last_consumed=Some(nonce.clone());renewals+=1;
                    consumed=true;deadline=Instant::now()+Duration::from_secs(3);
                    if let Some(anchor)=&anchor{if control{anchor.view.renew_control(&owner).await?;}else{anchor.view.renew()?;}anchored_renewals+=1;}
                    continue;
                }
                let id=request.id.clone().context("request id required")?;
                if let Some((original,response))=cache.get(&id){if original.as_slice()!=text.as_bytes(){bail!("request_id_conflict");}bridge.text(response.clone()).await?;continue;}
                let result:Result<Value>=async{
                    match request.method.as_str(){
                        "session.open" if !control=>{
                            if let Some(anchor)=&anchor{return Ok(serde_json::to_value(anchor.view.description())?);}
                            let view=app.open().await?;events=Some(view.events.subscribe());let result=serde_json::to_value(view.description())?;
                            anchor=Some(Anchor{view,control_owner:None});Ok(result)
                        },
                        "control.acquire" if control=>{
                            let view=app.session(required(&request.params,"sessionId")?,required(&request.params,"sessionToken")?).await?;
                            if request.params["targetGeneration"].as_u64()!=Some(u64::from(view.target.generation)){bail!("target_changed");}
                            events=Some(view.events.subscribe());
                            if anchor.as_ref().is_some_and(|a|a.view.id!=view.id){bail!("session_mismatch");}
                            if anchor.is_none(){anchor=Some(Anchor{view:view.clone(),control_owner:Some(owner.clone())});}
                            Ok(serde_json::to_value(view.acquire(&owner,deadline).await?)?)
                        },
                        "control.release" if control=>{if let Some(anchor)=&anchor{anchor.view.release_control(Some(&owner)).await?;}Ok(json!({"state":"released"}))},
                        "media.signal"|"media.feedback" if !control=>{
                            let anchor=anchor.as_ref().context("session_expired")?;
                            let view=app.session(required(&request.params,"sessionId")?,required(&request.params,"sessionToken")?).await?;
                            if anchor.view.id!=view.id{bail!("session_mismatch");}
                            if request.method=="media.feedback"{view.feedback(request.params["presentedFrames"].as_u64().context("invalid feedback")?);}
                            else{if request.params["generation"]!=1{bail!("invalid media generation");}
                                let candidate=if request.params["candidate"].is_null(){None}else{Some(serde_json::from_value(request.params["candidate"].clone())?)};
                                let media=view.media.lock().await.clone().context("media_not_ready")?;media.signal(candidate).await?;
                            }Ok(json!({}))
                        },
                        "state.get"=>Ok(app.status().await),
                        _=>bail!("unsupported_method"),
                    }
                }.await;
                let response=match result{Ok(result)=>json!({"id":id,"result":result}),Err(error)=>{
                    let message=error.to_string();let code=if["not_shared","encoder_unavailable","permission_required","desktop_unavailable","busy","session_expired","target_changed","lease_expired","media_not_connected","media_not_presenting","release_unconfirmed","unsupported_method"].contains(&message.as_str()){message.as_str()}else{"request_failed"};
                    json!({"id":id,"error":{"code":code,"message":code}})
                }};
                cache.insert(id.clone(),(text.as_bytes().to_vec(),response.clone()));order.push_back(id);
                if order.len()>128{if let Some(id)=order.pop_front(){cache.remove(&id);}}
                bridge.text(response).await?;
            },
        }
    }Ok(())}.await;
    // Report before cleanup: native startup/stop may still be blocked. The
    // transport cause must survive even when teardown needs the watchdog.
    {
        let message = outcome
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_else(|| "closed".into());
        let cause = if [
            "closed",
            "session_expired",
            "expired_challenge",
            "request_rate_exceeded",
            "bridge closed",
            "event stream ended or overflowed",
            "WS text missing",
            "expected WS text",
            "invalid WS application packet",
            "request id required",
            "invalid request",
            "bridge output closed",
            "bridge consumer timeout",
            "request_id_conflict",
        ]
        .contains(&message.as_str())
        {
            message.as_str()
        } else {
            "protocol_or_transport_error"
        };
        eprintln!(
            "Capture {} WS ended after {} ms; cause={cause}; challenges={challenges}; renewals={renewals}; anchored_renewals={anchored_renewals}; deadline_expired={}",
            if control { "control" } else { "view" },
            started_at.elapsed().as_millis(),
            Instant::now() >= deadline
        );
    }
    if let Some(anchor) = anchor {
        anchor.close().await;
    }
    outcome
}

async fn interrupted() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
pub async fn serve(
    listener: TcpListener,
    app: Arc<App>,
    secret: String,
    mut shutdown: oneshot::Receiver<()>,
) -> Result<()> {
    let slots = Arc::new(Semaphore::new(32));
    let mut tasks = tokio::task::JoinSet::new();
    let interrupt = interrupted();
    tokio::pin!(interrupt);
    loop {
        tokio::select! {
            _=&mut interrupt=>break,
            _=&mut shutdown=>break,
            accepted=listener.accept()=>{
                let(stream,_)=accepted?;let Ok(slot)=slots.clone().try_acquire_owned()else{continue};let app=app.clone();let secret=secret.clone();
                tasks.spawn(async move{let _slot=slot;
                    let result:Result<()>=async{
                        let mut bridge=tokio::time::timeout(Duration::from_secs(6),Bridge::accept(stream,&secret,&app.run_id)).await??;
                        let first=tokio::time::timeout(Duration::from_secs(5),bridge.recv()).await??;if first[0]!=0{bail!("operation required");}
                        let operation:Value=serde_json::from_slice(&first[1..])?;
                        match operation["kind"].as_str(){Some("http")=>handle_http(&mut bridge,&app,operation).await,Some("ws")=>handle_ws(&mut bridge,&app,operation).await,_=>bail!("unsupported bridge operation")}
                    }.await;
                    if result.is_err(){/* A probe may close after ready. No secrets/application payload are logged. */}
                });
            },
            _=tasks.join_next(),if!tasks.is_empty()=>{},
        }
    }
    app.stopping
        .store(true, std::sync::atomic::Ordering::SeqCst);
    app.policy(Some(0));
    let view = app.view.lock().await.clone();
    if let Some(view) = view {
        view.close("app_stopping").await;
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
