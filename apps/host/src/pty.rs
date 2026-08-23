//! The `pty` import: a real terminal, which WASI has no concept of.
//!
//! `portable_pty` is a blocking API — the master has no async form, and the
//! child must be waited on — so each session owns two threads and the guest
//! never sees either. What the guest sees is a buffer to take from and a
//! channel to put into, both of which answer immediately (v2 proposal §6.10).

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use wasmtime::component::Resource;

use crate::bindings::genehub::host::pty as wit;

/// What the reader thread has pulled off the master and the guest has not
/// taken. Bounded, because a terminal that nobody reads must not be able to
/// grow the shell's memory without limit — past the cap the reader parks,
/// which is the backpressure a pty has always had.
const MAX_BUFFERED: usize = 1024 * 1024;

#[derive(Default)]
struct Output {
    data: VecDeque<u8>,
    /// The master reached EOF. Distinct from the shell having exited: on some
    /// platforms the master does not report EOF until it is dropped.
    eof: bool,
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output: Arc<(Mutex<Output>, std::sync::Condvar)>,
    exit: Arc<Mutex<Option<i32>>>,
}

impl PtySession {
    fn open(
        argv: &[String],
        cwd: &str,
        env: &[(String, String)],
        cols: u16,
        rows: u16,
    ) -> Result<Self, String> {
        let (program, arguments) = argv.split_first().ok_or("empty argv")?;
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("allocating a pty: {error}"))?;

        let program = crate::guest_paths::host_path_from_guest(program)
            .to_string_lossy()
            .into_owned();
        let mut command = CommandBuilder::new(&program);
        for argument in arguments {
            command.arg(argument);
        }
        let cwd = crate::guest_paths::host_path_from_guest(cwd)
            .to_string_lossy()
            .into_owned();
        command.cwd(&cwd);
        for (key, value) in env {
            command.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("starting the shell: {error}"))?;
        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("taking the pty writer: {error}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("taking the pty reader: {error}"))?;

        let output = Arc::new((Mutex::new(Output::default()), std::sync::Condvar::new()));
        let sink = output.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let (lock, room) = &*sink;
                        let mut buffer = lock.lock().unwrap();
                        while buffer.data.len() + count > MAX_BUFFERED {
                            buffer = room.wait(buffer).unwrap();
                        }
                        buffer.data.extend(&chunk[..count]);
                    }
                }
            }
            sink.0.lock().unwrap().eof = true;
        });

        let exit = Arc::new(Mutex::new(None));
        let finished = exit.clone();
        // The shell can exit while this process still holds the master, and on
        // some platforms the reader then sees no EOF until the master drops.
        // So the child gets its own waiter rather than being inferred from the
        // stream going quiet.
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            *finished.lock().unwrap() = code.or(Some(-1));
        });

        Ok(PtySession {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            output,
            exit,
        })
    }

    /// `None` once drained *and* finished, so the guest can tell "the terminal
    /// is over" from "nothing has been typed yet".
    fn take(&self, max: usize) -> Option<Vec<u8>> {
        let (lock, room) = &*self.output;
        let mut buffer = lock.lock().unwrap();
        if buffer.data.is_empty() {
            let over = buffer.eof || self.exit.lock().unwrap().is_some();
            return if over { None } else { Some(Vec::new()) };
        }
        let take = max.min(buffer.data.len());
        let chunk: Vec<u8> = buffer.data.drain(..take).collect();
        room.notify_all();
        Some(chunk)
    }
}

impl wit::HostSession for crate::load::Host {
    async fn read(
        &mut self,
        this: Resource<PtySession>,
        max: u32,
    ) -> Result<Option<Vec<u8>>, String> {
        let session = self.table.get(&this).map_err(|error| error.to_string())?;
        Ok(session.take(max as usize))
    }

    async fn write(&mut self, this: Resource<PtySession>, data: Vec<u8>) -> Result<u32, String> {
        let session = self.table.get(&this).map_err(|error| error.to_string())?;
        let mut writer = session.writer.lock().unwrap();
        // Terminal input is keystrokes and paste, not a stream: small enough
        // that the master's own buffer takes it whole, and a short write here
        // is reported rather than retried behind the guest's back.
        let written = writer.write(&data).map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
        Ok(written as u32)
    }

    async fn resize(
        &mut self,
        this: Resource<PtySession>,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let session = self.table.get(&this).map_err(|error| error.to_string())?;
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    async fn exit_code(&mut self, this: Resource<PtySession>) -> Option<i32> {
        let session = self.table.get(&this).ok()?;
        *session.exit.lock().unwrap()
    }

    async fn drop(&mut self, this: Resource<PtySession>) -> wasmtime::Result<()> {
        // Dropping the master hangs the session up. What chose to ignore the
        // hangup chose it — see the note on `open`.
        let _ = self.table.delete(this);
        Ok(())
    }
}

impl wit::Host for crate::load::Host {
    async fn open(
        &mut self,
        argv: Vec<String>,
        cwd: String,
        env: Vec<(String, String)>,
        cols: u16,
        rows: u16,
    ) -> Result<Resource<PtySession>, String> {
        let session = PtySession::open(&argv, &cwd, &env, cols, rows)?;
        self.table.push(session).map_err(|error| error.to_string())
    }
}
