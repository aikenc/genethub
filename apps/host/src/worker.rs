//! One Store per worker thread, owned by a daemon component generation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use anyhow::Context as _;
use tokio::sync::mpsc::{self, error::TryRecvError, Receiver, Sender};
use wasmtime::component::{Component, Resource};
use wasmtime::{Engine, StoreLimitsBuilder, UpdateDeadline};
use wasmtime_wasi::WasiCtxBuilder;

use crate::bindings::{genehub::host::worker as wit, Daemon};
use crate::load::{add_daemon_imports, worker_capable_instance, Host};
use crate::tls_server::Connection;

const MAX_THREADS: usize = 8;
const QUEUE_DEPTH: usize = 2;
const MAX_PENDING_CONNECTIONS: usize = 8;
const MAX_MESSAGE: usize = 1024 * 1024;

pub(crate) struct Mailbox {
    send: Sender<Vec<u8>>,
    receive: Receiver<Vec<u8>>,
}

impl Mailbox {
    fn pair() -> (Self, Self) {
        let (outbound, incoming) = mpsc::channel(QUEUE_DEPTH);
        let (inbound, outgoing) = mpsc::channel(QUEUE_DEPTH);
        (
            Self {
                send: outbound,
                receive: outgoing,
            },
            Self {
                send: inbound,
                receive: incoming,
            },
        )
    }

    fn send(&self, message: Vec<u8>) -> Result<(), String> {
        if message.len() > MAX_MESSAGE {
            return Err("worker message exceeds its budget".into());
        }
        self.send.try_send(message).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => "worker mailbox is full".into(),
            mpsc::error::TrySendError::Closed(_) => "worker mailbox closed".into(),
        })
    }

    fn receive(&mut self) -> Result<Option<Vec<u8>>, String> {
        match self.receive.try_recv() {
            Ok(message) => Ok(Some(message)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => Err("worker mailbox closed".into()),
        }
    }
}

struct Thread {
    cancelled: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

pub(crate) struct Manager {
    engine: Engine,
    component: Component,
    threads: Vec<Thread>,
    connections: Receivers,
    next_id: u64,
}

impl Manager {
    pub(crate) fn new(engine: Engine, component: Component) -> Self {
        Self {
            engine,
            component,
            threads: Vec::new(),
            connections: Receivers::default(),
            next_id: 1,
        }
    }

    fn start(&mut self, entry: String, arguments: Vec<String>) -> Result<Instance, String> {
        let mut index = 0;
        while index < self.threads.len() {
            if self.threads[index].handle.is_finished() {
                let _ = self.threads.swap_remove(index).handle.join();
            } else {
                index += 1;
            }
        }
        if self.threads.len() >= MAX_THREADS
            || entry.len() > 64
            || arguments.len() > 8
            || arguments.iter().any(|arg| arg.len() > 4096)
        {
            return Err("worker start exceeds its budget".into());
        }
        let (manager, mailbox) = Mailbox::pair();
        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).ok_or("worker ID exhausted")?;
        let (incoming, receive) = mpsc::channel(MAX_PENDING_CONNECTIONS);
        let state = WorkerState {
            mailbox,
            receive,
            target: ConnectionTarget {
                id,
                connections: self.connections.clone(),
            },
        };
        self.connections.insert(id, incoming)?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let handle = {
            let engine = self.engine.clone();
            let component = self.component.clone();
            let cancelled = cancelled.clone();
            thread::Builder::new()
                .name("genehub-wasm-worker".into())
                .spawn(move || {
                    if let Err(error) =
                        run(&engine, &component, state, &cancelled, &entry, &arguments)
                    {
                        if !cancelled.load(Ordering::Acquire) {
                            if crate::channel::CHANNEL == "local" {
                                eprintln!("background WASM worker failed: {error:#}");
                            } else {
                                eprintln!("background WASM worker failed: {error}");
                            }
                        }
                    }
                })
                .map_err(|error| error.to_string())?
        };
        self.threads.push(Thread {
            cancelled: cancelled.clone(),
            handle,
        });
        Ok(Instance {
            id,
            mailbox: manager,
            cancelled,
            engine: self.engine.clone(),
        })
    }
}

impl Drop for Manager {
    fn drop(&mut self) {
        for worker in &self.threads {
            worker.cancelled.store(true, Ordering::Release);
        }
        self.engine.increment_epoch();
        for worker in self.threads.drain(..) {
            let _ = worker.handle.join();
        }
    }
}

pub struct Instance {
    id: u64,
    mailbox: Mailbox,
    cancelled: Arc<AtomicBool>,
    engine: Engine,
}

impl Drop for Instance {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        self.engine.increment_epoch();
    }
}

#[derive(Clone, Default)]
struct Receivers(Arc<Mutex<HashMap<u64, Sender<Connection>>>>);

impl Receivers {
    fn insert(&self, id: u64, sender: Sender<Connection>) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "worker registry unavailable")?
            .insert(id, sender);
        Ok(())
    }

    fn transfer(&self, id: u64, connection: Connection) -> Result<(), String> {
        let sender = self
            .0
            .lock()
            .map_err(|_| "worker registry unavailable")?
            .get(&id)
            .cloned()
            .ok_or("worker is no longer available")?;
        sender
            .try_send(connection)
            .map_err(|_| "worker connection queue full or closed".into())
    }
}

struct ConnectionTarget {
    id: u64,
    connections: Receivers,
}

impl Drop for ConnectionTarget {
    fn drop(&mut self) {
        if let Ok(mut connections) = self.connections.0.lock() {
            connections.remove(&self.id);
        }
    }
}

pub(crate) struct WorkerState {
    mailbox: Mailbox,
    receive: Receiver<Connection>,
    target: ConnectionTarget,
}

pub(crate) enum State {
    Disabled,
    Manager(Manager),
    Worker(WorkerState),
}

impl State {
    pub(crate) fn transfer(&self, id: u64, connection: Connection) -> Result<(), String> {
        let registry = match self {
            Self::Manager(manager) => &manager.connections,
            Self::Worker(worker) if worker.target.id != id => &worker.target.connections,
            _ => return Err("invalid worker transfer".into()),
        };
        registry.transfer(id, connection)
    }

    pub(crate) fn accept_transfer(&mut self) -> Result<Option<Connection>, String> {
        match self {
            Self::Worker(worker) => match worker.receive.try_recv() {
                Ok(connection) => Ok(Some(connection)),
                Err(TryRecvError::Empty) => Ok(None),
                Err(TryRecvError::Disconnected) => Err("worker connection queue closed".into()),
            },
            _ => Err("no worker connection queue".into()),
        }
    }
}

fn run(
    engine: &Engine,
    component: &Component,
    state: WorkerState,
    cancelled: &Arc<AtomicBool>,
    entry: &str,
    arguments: &[String],
) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let mut wasi = WasiCtxBuilder::new();
        wasi.inherit_network()
            .allow_tcp(true)
            .allow_ip_name_lookup(true);
        let (mut store, mut linker) = worker_capable_instance(engine, wasi)?;
        // The component carries all imports. The worker has no inherited
        // arguments, process stdin or filesystem preopens.
        add_daemon_imports(&mut linker)?;
        store.data_mut().worker = State::Worker(state);
        store.data_mut().limits = StoreLimitsBuilder::new()
            .memory_size(128 * 1024 * 1024)
            .build();
        store.limiter(|host| &mut host.limits);
        let interrupt = cancelled.clone();
        store.epoch_deadline_callback(move |_| {
            if interrupt.load(Ordering::Acquire) {
                return Err(wasmtime::Error::msg("background worker cancelled"));
            }
            Ok(UpdateDeadline::Continue(1))
        });
        if let State::Worker(worker) = &store.data().worker {
            if worker.mailbox.send.is_closed() || cancelled.load(Ordering::Acquire) {
                return Ok(());
            }
        }
        let guest = Daemon::instantiate_async(&mut store, component, &linker)
            .await
            .map_err(anyhow::Error::from)
            .context("instantiate worker component")?;
        guest
            .call_worker_run(&mut store, entry, arguments)
            .await
            .map_err(anyhow::Error::from)
            .context("worker trapped")?
            .map_err(anyhow::Error::msg)
            .context("worker entry returned an error")?;
        Ok(())
    })
}

impl wit::Host for Host {
    async fn start(
        &mut self,
        entry: String,
        arguments: Vec<String>,
    ) -> Result<Resource<Instance>, String> {
        let State::Manager(manager) = &mut self.worker else {
            return Err("only the daemon may start workers".into());
        };
        self.table
            .push(manager.start(entry, arguments)?)
            .map_err(|error| error.to_string())
    }

    async fn receive(&mut self) -> Result<Option<Vec<u8>>, String> {
        let State::Worker(worker) = &mut self.worker else {
            return Err("no worker inbox".into());
        };
        worker.mailbox.receive()
    }

    async fn send(&mut self, message: Vec<u8>) -> Result<(), String> {
        let State::Worker(worker) = &self.worker else {
            return Err("no worker outbox".into());
        };
        worker.mailbox.send(message)
    }
}

impl wit::HostInstance for Host {
    async fn id(&mut self, instance: Resource<Instance>) -> u64 {
        self.table.get(&instance).map_or(0, |instance| instance.id)
    }

    async fn closed(&mut self, instance: Resource<Instance>) -> bool {
        self.table
            .get(&instance)
            .map_or(true, |instance| instance.mailbox.send.is_closed())
    }

    async fn send(&mut self, instance: Resource<Instance>, message: Vec<u8>) -> Result<(), String> {
        self.table
            .get(&instance)
            .map_err(|error| error.to_string())?
            .mailbox
            .send(message)
    }

    async fn receive(&mut self, instance: Resource<Instance>) -> Result<Option<Vec<u8>>, String> {
        self.table
            .get_mut(&instance)
            .map_err(|error| error.to_string())?
            .mailbox
            .receive()
    }

    async fn drop(&mut self, instance: Resource<Instance>) -> wasmtime::Result<()> {
        drop(self.table.delete(instance)?);
        Ok(())
    }
}
