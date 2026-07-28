use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Local port the bundled daemon listens on. Loopback only: remote access goes
/// through the relay, never through an open port on this machine.
pub const DAEMON_PORT: u16 = 7777;

/// Owns the bundled `paseo` daemon process.
///
/// The daemon must outlive the main window (closing the window only hides it),
/// and must not outlive the tray: a daemon with no visible owner is exactly the
/// kind of stray agent host we are trying to avoid.
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    paseo_bin: PathBuf,
    pi_bin: Option<PathBuf>,
    home: PathBuf,
}

impl Sidecar {
    pub fn new(paseo_bin: PathBuf, pi_bin: Option<PathBuf>, home: PathBuf) -> Self {
        Self {
            child: Mutex::new(None),
            paseo_bin,
            pi_bin,
            home,
        }
    }

    pub fn daemon_host(&self) -> String {
        format!("127.0.0.1:{DAEMON_PORT}")
    }

    pub fn paseo_bin(&self) -> &PathBuf {
        &self.paseo_bin
    }

    pub fn start(&self) -> std::io::Result<()> {
        let mut guard = self.child.lock().expect("sidecar lock");
        if guard.is_some() {
            return Ok(());
        }

        std::fs::create_dir_all(&self.home)?;

        let mut command = Command::new(&self.paseo_bin);
        command
            .arg("daemon")
            .arg("start")
            .arg("--foreground")
            .arg("--home")
            .arg(&self.home)
            .arg("--port")
            .arg(DAEMON_PORT.to_string())
            .arg("--relay-use-tls")
            // The GeneHub web app is the entry point; the daemon does not serve one.
            .arg("--no-web-ui")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        // Point the daemon at the bundled PI Agent so a fresh install can run a
        // task without the user installing any agent CLI first.
        if let Some(pi) = &self.pi_bin {
            command.env("PI_COMMAND", pi);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        *guard = Some(command.spawn()?);
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let mut guard = self.child.lock().expect("sidecar lock");
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(_)) => {
                    *guard = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            },
            None => false,
        }
    }

    pub fn stop(&self) {
        let mut guard = self.child.lock().expect("sidecar lock");
        if let Some(mut child) = guard.take() {
            // Ask the daemon to shut down cleanly first so agents are not orphaned.
            let _ = Command::new(&self.paseo_bin)
                .arg("daemon")
                .arg("stop")
                .arg("--home")
                .arg(&self.home)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();

            for _ in 0..20 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
