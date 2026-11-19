//! User service management for the normal channel installation. Explicit
//! alternate data roots still use the manual lifecycle.

use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output};

use anyhow::{bail, ensure, Context, Result};
use fs2::FileExt;
use serde_json::{json, Value};

use super::{
    facts, find_service, health, live_pid, read_endpoint, Manager, Service, START_TIMEOUT,
};

mod wsl;

// Sessions, workspace locks and connections share the host process's budget.
const LAUNCHD_NOFILE_FLOOR: u64 = 16_384;
const LAUNCHD_SOFT_NOFILE: &str = "SoftResourceLimits.NumberOfFiles";
const LAUNCHD_HARD_NOFILE: &str = "HardResourceLimits.NumberOfFiles";
use genet_frontdoor::{channel, lifecycle, Paths};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Action {
    Install { refresh: bool },
    Start,
    Restart,
    Stop,
}

pub(super) fn configured(paths: &Paths) -> Option<Service> {
    if Paths::platform_root().ok().as_ref() != Some(&paths.root) {
        return None;
    }
    let home = std::path::PathBuf::from(std::env::var_os("HOME")?);
    let config = std::env::var_os("XDG_CONFIG_HOME").map(std::path::PathBuf::from);
    find_service(
        &home,
        config.as_deref(),
        std::env::consts::OS,
        channel::CHANNEL,
    )
}

pub(super) fn apply(paths: &Paths, action: Action) -> Result<Option<Value>> {
    let Some(service) = configured(paths) else {
        return Ok(None);
    };
    if !service.file.is_file() && action == Action::Stop {
        return Ok(None);
    }
    if !service.available() {
        ensure!(
            !service.file.is_file(),
            "the installed service manager is unavailable"
        );
        return Ok(None);
    }

    let _lock = lock_service(paths)?;

    let stopped = paths.root.join("service-stopped");
    let install = matches!(action, Action::Install { .. });
    let was_stopped = stopped.is_file();
    if install && was_stopped {
        return Ok(Some(
            json!({"running": false, "service": service.report(paths), "desiredState": "stopped"}),
        ));
    }

    let prior = service.observed()?;
    let pid = live_pid(paths);
    let installed = service.file.is_file();
    if action == Action::Stop {
        service.ensure_owner(prior.pid, pid)?;
        independent_caller(pid)?;
        service.stop(&prior)?;
        wait_stopped(paths)?;
        write_atomic(&stopped, b"stopped\n")?;
        let mut report = service.report_local();
        if let Some(host) = wsl::update(paths, "stop") {
            report["windowsAutostart"] = host;
        }
        return Ok(Some(
            json!({"stopped":pid.is_some(), "running":false, "service":report}),
        ));
    }

    if !installed && prior.pid.is_none() && lifecycle::instance_locked(paths)? {
        if install || action == Action::Start {
            let mut running = facts(paths);
            ensure!(
                running["running"] == true && running["port"].as_u64().is_some(),
                "the standalone daemon is starting or unresponsive"
            );
            running["service"] = Value::Null;
            running["deferred"] = json!(true);
            running["started"] = json!(false);
            running["alreadyRunning"] = json!(true);
            return Ok(Some(running));
        }
        return Ok(None);
    }

    if install && installed {
        service.verify_install_location()?;
    }
    let needs_definition = !installed || service.needs_background(&prior);
    let restart = action == Action::Restart || action == (Action::Install { refresh: true });
    service.ensure_owner(prior.pid, pid)?;
    if (restart || needs_definition) && pid.is_some() {
        if install && caller_depends_on(pid)? {
            return Ok(Some(
                json!({"running": true, "service":service.report(paths), "deferred":true}),
            ));
        }
        independent_caller(pid)?;
    }

    let backup = if needs_definition && installed {
        ensure!(
            fs::symlink_metadata(&service.file)?.file_type().is_file(),
            "cannot migrate a launchd definition that is not a regular file"
        );
        let bytes = fs::read(&service.file)?;
        write_atomic(&paths.root.join("service-definition.backup"), &bytes)?;
        Some(bytes)
    } else {
        None
    };
    if needs_definition {
        let cli = std::env::current_exe().context("locating installed CLI")?;
        service.write_definition(&cli, backup.as_deref(), &paths.root)?;
    }
    let result: Result<Value> = (|| {
        service.start(&prior, needs_definition, restart)?;
        let mut ready = wait_ready(paths, &service)?;
        if service.manager == Manager::Systemd && linger() == Some(false) {
            let _ = Command::new("loginctl")
                .args(["--no-ask-password", "enable-linger", &uid()?])
                .output();
        }
        let ready_pid = ready["pid"].as_u64();
        ready["started"] = json!(pid.map(u64::from) != ready_pid);
        ready["alreadyRunning"] = json!(pid.map(u64::from) == ready_pid);
        let mut report = service.report_local();
        if let Some(host) = wsl::update(paths, "start") {
            if host["configured"] != true {
                let warning = host["warning"]
                    .as_str()
                    .unwrap_or("Windows did not confirm the scheduled task");
                eprintln!("warning: the WSL daemon is running; Windows autostart could not be configured: {warning}");
            }
            report["windowsAutostart"] = host;
        }
        ready["service"] = report;
        Ok(ready)
    })();
    if let Err(error) = result {
        if needs_definition {
            service.rollback(&prior, backup.as_deref(), !install || !restart)
                .with_context(|| format!("service activation failed ({error:#}); previous service could not be restored"))?;
            return Err(error.context("service activation failed; previous definition restored"));
        }
        if was_stopped {
            service.stop(&service.observed()?).with_context(|| {
                format!(
                    "service activation failed ({error:#}); stopped state could not be restored"
                )
            })?;
        }
        return Err(error);
    }
    if was_stopped {
        fs::remove_file(&stopped)?;
    }
    result.map(Some)
}

fn lock_service(paths: &Paths) -> Result<fs::File> {
    paths.ensure()?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths.root.join("service.lock"))?;
    lock.lock_exclusive()?;
    Ok(lock)
}

/// Installation files have already been restored. Start the previous
/// definition in its original domain and verify the original machine identity.
pub(super) fn restore(paths: &Paths, machine_id: &str, old_pid: u32) -> Result<Value> {
    let _lock = lock_service(paths)?;
    if let Some(endpoint) = read_endpoint(paths)
        .filter(|endpoint| live_pid(paths) == Some(endpoint.pid) && health(endpoint))
    {
        ensure!(
            endpoint.machine_id == machine_id,
            "the active daemon has a different machine identity"
        );
        if endpoint.pid == old_pid {
            return Ok(facts(paths));
        }
    }
    let service = configured(paths)
        .filter(|service| service.file.is_file())
        .context("cannot recover a stopped standalone daemon through the service manager")?;
    ensure!(
        service.available(),
        "the previous service manager is unavailable"
    );
    let prior = service.observed()?;
    let pid = live_pid(paths);
    service.ensure_owner(prior.pid, pid)?;
    independent_caller(pid)?;
    match service.manager {
        Manager::Systemd => check(
            service.systemctl(&["restart", &service.name])?,
            "restart the previous systemd service",
        )?,
        Manager::Launchd if prior.loaded => check(
            launchctl(&["kickstart", "-k", &prior.target])?,
            "restart the previous launchd service",
        )?,
        Manager::Launchd => {
            let (domain, _) = prior
                .target
                .rsplit_once('/')
                .context("missing previous launchd domain")?;
            service.bootstrap(domain)?;
        }
    }
    let ready = wait_ready(paths, &service)?;
    ensure!(
        read_endpoint(paths).is_some_and(|endpoint| endpoint.machine_id == machine_id),
        "the restored daemon published a different machine identity"
    );
    Ok(ready)
}

struct Observed {
    target: String,
    pid: Option<u32>,
    loaded: bool,
    details: Value,
}

impl Service {
    fn systemctl(&self, args: &[&str]) -> Result<Output> {
        let mut command = Command::new("systemctl");
        command.arg("--user").args(args);
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
            let uid = uid()?;
            command.env("XDG_RUNTIME_DIR", format!("/run/user/{uid}"));
        }
        command.output().context("calling systemctl --user")
    }

    fn available(&self) -> bool {
        match self.manager {
            Manager::Systemd => self
                .systemctl(&["show-environment"])
                .is_ok_and(|out| out.status.success()),
            Manager::Launchd => self.background_domain().is_ok_and(|domain| {
                launchctl(&["print", &domain]).is_ok_and(|out| out.status.success())
            }),
        }
    }

    fn background_domain(&self) -> Result<String> {
        Ok(format!("user/{}", uid()?))
    }

    fn plist_field(&self, key: &str) -> Option<String> {
        let output = Command::new("/usr/bin/plutil")
            .args(["-extract", key, "raw", "-o", "-"])
            .arg(&self.file)
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn launchd_file_limit(&self) -> (Option<u64>, u64) {
        let read_limit = |key| self.plist_field(key).and_then(|value| value.parse().ok());
        let soft = read_limit(LAUNCHD_SOFT_NOFILE);
        let hard = read_limit(LAUNCHD_HARD_NOFILE);
        let requested = soft
            .unwrap_or(LAUNCHD_NOFILE_FLOOR)
            .max(LAUNCHD_NOFILE_FLOOR);
        (soft, hard.map_or(requested, |hard| requested.min(hard)))
    }

    pub(crate) fn launchd_target(&self) -> Result<String> {
        Ok(self.observed()?.target)
    }

    fn observed(&self) -> Result<Observed> {
        match self.manager {
            Manager::Systemd => {
                let out = self.systemctl(&["show", &self.name, "--property=LoadState,MainPID,ActiveState,UnitFileState,Restart,LimitNOFILESoft,FragmentPath"])?;
                let text = String::from_utf8(out.stdout)?;
                let field = |name: &str| {
                    text.lines()
                        .filter_map(|line| line.split_once('='))
                        .find_map(|(key, value)| (key == name).then_some(value))
                };
                let loaded = field("LoadState") == Some("loaded");
                ensure!(
                    out.status.success() || field("LoadState") == Some("not-found"),
                    "systemctl show failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                );
                if loaded {
                    let file = field("FragmentPath")
                        .context("systemd did not report the loaded service definition")?;
                    ensure!(
                        fs::canonicalize(file)? == fs::canonicalize(&self.file)?,
                        "the loaded systemd definition is outside this GeneHub installation"
                    );
                }
                Ok(Observed {
                    target: self.name.clone(),
                    pid: field("MainPID")
                        .and_then(|v| v.parse().ok())
                        .filter(|pid| *pid != 0),
                    loaded,
                    details: json!({
                        "manager":"systemd",
                        "state":field("ActiveState"),
                        "enabled":field("UnitFileState"),
                        "restart":field("Restart"),
                        "maxFiles":field("LimitNOFILESoft").and_then(|v| v.parse::<u64>().ok()),
                        "linger": linger(),
                        "wsl": is_wsl(),

                    }),
                })
            }
            Manager::Launchd => {
                let uid = uid()?;
                for domain in [format!("user/{uid}"), format!("gui/{uid}")] {
                    let target = format!("{domain}/{}", self.name);
                    let out = launchctl(&["print", &target])?;
                    if !out.status.success() {
                        continue;
                    }
                    let text = String::from_utf8_lossy(&out.stdout);
                    let field = |key| text.lines().find_map(|line| line.trim().strip_prefix(key));
                    let properties = field("properties = ").unwrap_or_default();
                    return Ok(Observed {
                        target,
                        loaded: true,
                        pid: field("pid = ").and_then(|v| v.trim().parse().ok()),
                        details: json!({
                            "manager":"launchd",
                            "domain":domain,
                            "state":field("state = "),
                            "keepAlive":properties.contains("keepalive"),
                            "runAtLoad":properties.contains("runatload"),
                            "maxFiles":field("maxfiles (soft) => ").and_then(|v| v.trim().parse::<u64>().ok()),
                        }),
                    });
                }
                let domain = if self.file.is_file()
                    && self.plist_field("LimitLoadToSessionType").as_deref() != Some("Background")
                {
                    format!("gui/{uid}")
                } else {
                    format!("user/{uid}")
                };
                Ok(Observed {
                    target: format!("{domain}/{}", self.name),
                    pid: None,
                    loaded: false,
                    details: json!({"manager":"launchd", "domain":domain, "state":"unloaded"}),
                })
            }
        }
    }

    pub(super) fn report(&self, paths: &Paths) -> Value {
        let mut report = self.report_local();
        if let Some(host) = wsl::update(paths, "status") {
            report["windowsAutostart"] = host;
        }
        report
    }

    fn report_local(&self) -> Value {
        let mut report = match self.observed() {
            Ok(observed) => {
                let mut details = observed.details;
                details["pid"] = json!(observed.pid);
                if self.manager == Manager::Launchd {
                    if let Some(limit) = details["maxFiles"].as_u64() {
                        if limit < LAUNCHD_NOFILE_FLOOR {
                            details["maxFilesWarning"] = json!(format!(
                                "the effective file descriptor limit is {limit}; the default GeneHub budget is {LAUNCHD_NOFILE_FLOOR}"
                            ));
                        }
                    }
                }
                details
            }
            Err(error) => json!({"manager":self.manager.name(), "error":error.to_string()}),
        };
        report["definition"] = json!(self.file);
        report
    }

    fn verify_install_location(&self) -> Result<()> {
        let executable = std::env::current_exe()?.canonicalize()?;
        let program = match self.manager {
            Manager::Systemd => {
                let output =
                    self.systemctl(&["show", &self.name, "--property=ExecStart", "--value"])?;
                ensure!(
                    output.status.success(),
                    "could not inspect the existing systemd service executable"
                );
                String::from_utf8(output.stdout)?
                    .split_once("path=")
                    .and_then(|(_, fields)| fields.split_once(" ; "))
                    .map(|(path, _)| path.to_owned())
            }
            Manager::Launchd => self
                .plist_field("Program")
                .or_else(|| self.plist_field("ProgramArguments.0")),
        }
        .context("the existing service executable is unknown; the active service was left alone")?;
        let program = Path::new(&program).canonicalize()?;
        let host = executable.with_file_name(channel::HOST_BINARY);
        ensure!(
            program == executable || host.canonicalize().is_ok_and(|host| program == host),
            "the existing service uses another executable at {}; the active service was left alone",
            program.display()
        );
        Ok(())
    }

    fn ensure_owner(&self, expected: Option<u32>, actual: Option<u32>) -> Result<()> {
        if let Some(pid) = actual {
            ensure!(expected == Some(pid), "the running daemon is not owned by the configured {} service; leave it running or stop it from its original supervisor", self.manager.name());
        } else if expected.is_some() {
            bail!(
                "the {} service is running without a verified GeneHub runtime",
                self.manager.name()
            );
        }
        Ok(())
    }

    fn needs_background(&self, prior: &Observed) -> bool {
        if self.manager != Manager::Launchd {
            return false;
        }
        let (soft, target) = self.launchd_file_limit();
        prior.target.starts_with("gui/")
            || self.plist_field("LimitLoadToSessionType").as_deref() != Some("Background")
            || soft != Some(target)
            || self.plist_field("RunAtLoad").as_deref() != Some("true")
            || self.plist_field("KeepAlive").as_deref() != Some("true")
    }

    fn stop(&self, prior: &Observed) -> Result<()> {
        match self.manager {
            Manager::Systemd => check(
                self.systemctl(&["disable", "--now", &self.name])?,
                "disable and stop service",
            ),
            Manager::Launchd => {
                let background = format!("{}/{}", self.background_domain()?, self.name);
                check(
                    launchctl(&["disable", &background])?,
                    "disable launchd service",
                )?;
                if prior.target != background {
                    check(
                        launchctl(&["disable", &prior.target])?,
                        "disable legacy launchd service",
                    )?;
                }
                if prior.loaded {
                    check(
                        launchctl(&["bootout", &prior.target])?,
                        "stop launchd service",
                    )?;
                }
                Ok(())
            }
        }
    }

    fn start(&self, prior: &Observed, updated: bool, restart: bool) -> Result<()> {
        match self.manager {
            Manager::Systemd => {
                if updated {
                    check(
                        self.systemctl(&["daemon-reload"])?,
                        "reload systemd definitions",
                    )?;
                }
                if prior.details["enabled"] != "enabled" {
                    check(
                        self.systemctl(&["enable", &self.name])?,
                        "enable systemd service",
                    )?;
                }
                let verb = if restart { "restart" } else { "start" };
                check(
                    self.systemctl(&[verb, &self.name])?,
                    "activate systemd service",
                )?;
                Ok(())
            }
            Manager::Launchd => {
                let domain = self.background_domain()?;
                let target = format!("{domain}/{}", self.name);
                if updated && prior.loaded {
                    check(
                        launchctl(&["bootout", &prior.target])?,
                        "unregister old launchd service",
                    )?;
                    wait_unloaded(&prior.target)?;
                }
                check(launchctl(&["enable", &target])?, "enable launchd service")?;
                if !prior.loaded || updated {
                    self.bootstrap(&domain)?;
                } else if restart {
                    check(
                        launchctl(&["kickstart", "-k", &target])?,
                        "restart launchd service",
                    )?;
                } else if prior.pid.is_none() {
                    check(launchctl(&["kickstart", &target])?, "start launchd service")?;
                }
                Ok(())
            }
        }
    }

    fn bootstrap(&self, domain: &str) -> Result<()> {
        let output = Command::new("/bin/launchctl")
            .arg("bootstrap")
            .arg(domain)
            .arg(&self.file)
            .output()?;
        check(output, "register launchd service")
    }

    fn rollback(&self, prior: &Observed, old: Option<&[u8]>, restore_process: bool) -> Result<()> {
        match self.manager {
            Manager::Systemd => {
                check(
                    self.systemctl(&["disable", "--now", &self.name])?,
                    "retire failed systemd service",
                )?;
                fs::remove_file(&self.file)?;
                check(
                    self.systemctl(&["daemon-reload"])?,
                    "reload systemd after rollback",
                )
            }
            Manager::Launchd => {
                let target = format!("{}/{}", self.background_domain()?, self.name);
                if launchctl(&["print", &target])?.status.success() {
                    check(
                        launchctl(&["bootout", &target])?,
                        "retire failed launchd service",
                    )?;
                    wait_unloaded(&target)?;
                }
                if let Some(bytes) = old {
                    write_atomic(&self.file, bytes)?;
                    if restore_process
                        && prior.loaded
                        && !launchctl(&["print", &prior.target])?.status.success()
                    {
                        let (domain, _) = prior
                            .target
                            .rsplit_once('/')
                            .context("missing legacy launchd domain")?;
                        check(
                            launchctl(&["enable", &prior.target])?,
                            "enable previous launchd service",
                        )?;
                        self.bootstrap(domain)?;
                    }
                    Ok(())
                } else {
                    fs::remove_file(&self.file).context("remove failed launchd definition")
                }
            }
        }
    }

    fn write_definition(&self, cli: &Path, old: Option<&[u8]>, root: &Path) -> Result<()> {
        let value = match self.manager {
            Manager::Systemd => self.systemd_definition(cli, root)?,
            Manager::Launchd => {
                if let Some(old) = old {
                    let (_, limit) = self.launchd_file_limit();
                    return update_plist(&self.file, old, limit);
                }
                self.launchd_definition(cli, root)?
            }
        };
        write_atomic(&self.file, value.as_bytes())
    }

    fn systemd_definition(&self, cli: &Path, root: &Path) -> Result<String> {
        let cli = quote_systemd(cli.as_os_str())?;
        let root = quote_systemd(root.as_os_str())?;
        let path = quote_systemd(&std::env::var_os("PATH").unwrap_or_default())?;
        let env = self
            .file
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .context("missing config directory")?
            .join("genehub")
            .join(format!("{}.env", channel::CHANNEL));
        let env = quote_systemd(env.as_os_str())?;
        Ok(format!("[Unit]\nDescription=GeneHub daemon ({})\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nExecStart=:\"{cli}\" daemon run\nWorkingDirectory=%h\nEnvironment=\"PATH={path}\"\nEnvironment=\"{data_env}={root}\"\nEnvironmentFile=-{env}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n", channel::CHANNEL, data_env = channel::ENV_DATA_DIR))
    }

    fn launchd_definition(&self, cli: &Path, root: &Path) -> Result<String> {
        let cli = xml(cli.to_str().context("CLI path is not valid UTF-8")?);
        let root = xml(root.to_str().context("data directory is not valid UTF-8")?);
        let home = xml(&std::env::var("HOME")?);
        let path = xml(&std::env::var("PATH").unwrap_or_default());
        Ok(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{}</string>\n<key>ProgramArguments</key><array><string>{cli}</string><string>daemon</string><string>run</string></array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>{path}</string><key>{data_env}</key><string>{root}</string></dict>\n<key>WorkingDirectory</key><string>{home}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>LimitLoadToSessionType</key><string>Background</string>\n<key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>{LAUNCHD_NOFILE_FLOOR}</integer></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n</dict></plist>\n", self.name, data_env = channel::ENV_DATA_DIR))
    }
}

fn update_plist(path: &Path, old: &[u8], nofile: u64) -> Result<()> {
    let nofile = nofile.to_string();
    let temp = path.with_file_name(format!(".genehub-{}.plist", uuid::Uuid::new_v4()));
    let result = (|| {
        write_atomic(&temp, old)?;
        for (key, kind, value) in [
            ("LimitLoadToSessionType", "-string", "Background"),
            ("RunAtLoad", "-bool", "true"),
            ("KeepAlive", "-bool", "true"),
            (LAUNCHD_SOFT_NOFILE, "-integer", nofile.as_str()),
        ] {
            let output = Command::new("/usr/bin/plutil")
                .args(["-replace", key, kind, value])
                .arg(&temp)
                .output()?;
            if !output.status.success() {
                if key == LAUNCHD_SOFT_NOFILE {
                    let _ = Command::new("/usr/bin/plutil")
                        .args(["-insert", "SoftResourceLimits", "-xml", "<dict/>"])
                        .arg(&temp)
                        .output()?;
                }
                check(
                    Command::new("/usr/bin/plutil")
                        .args(["-insert", key, kind, value])
                        .arg(&temp)
                        .output()?,
                    "update launchd plist",
                )?;
            }
        }
        genet_frontdoor::perms::restrict_to_owner(&temp)?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}

fn quote_systemd(value: &std::ffi::OsStr) -> Result<String> {
    let value = value
        .to_str()
        .context("systemd setting is not valid UTF-8")?;
    ensure!(
        !value.chars().any(|c| matches!(c, '\0' | '\n' | '\r')),
        "invalid line break in systemd setting"
    );
    Ok(value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%"))
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("missing service definition directory")?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".genehub-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn uid() -> Result<String> {
    let output = Command::new("/usr/bin/id").arg("-u").output()?;
    ensure!(
        output.status.success(),
        "could not determine the current user ID"
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn launchctl(args: &[&str]) -> Result<Output> {
    Command::new("/bin/launchctl")
        .args(args)
        .output()
        .context("calling launchctl")
}

fn check(output: Output, action: &str) -> Result<()> {
    ensure!(
        output.status.success(),
        "{action}: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}

fn linger() -> Option<bool> {
    let output = Command::new("loginctl")
        .args(["show-user", &uid().ok()?, "-p", "Linger", "--value"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    }
}

fn is_wsl() -> bool {
    fs::read_to_string("/proc/sys/kernel/osrelease")
        .is_ok_and(|v| v.to_lowercase().contains("microsoft"))
}

fn independent_caller(pid: Option<u32>) -> Result<()> {
    ensure!(
        !caller_depends_on(pid)?,
        "this shell depends on the daemon; use an independent terminal"
    );
    Ok(())
}

fn caller_depends_on(pid: Option<u32>) -> Result<bool> {
    let Some(daemon) = pid else { return Ok(false) };
    let mut current = std::process::id();
    while current > 1 {
        if current == daemon {
            return Ok(true);
        }
        let output = Command::new("/bin/ps")
            .args([
                OsString::from("-o"),
                "ppid=".into(),
                "-p".into(),
                current.to_string().into(),
            ])
            .output()?;
        ensure!(
            output.status.success(),
            "could not verify the caller process ancestry"
        );
        current = String::from_utf8(output.stdout)?.trim().parse()?;
    }
    Ok(false)
}

fn wait_unloaded(target: &str) -> Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while launchctl(&["print", target])?.status.success() {
        ensure!(
            std::time::Instant::now() < deadline,
            "launchd service still registered"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(())
}

fn wait_stopped(paths: &Paths) -> Result<()> {
    let deadline = std::time::Instant::now() + START_TIMEOUT;
    while lifecycle::instance_locked(paths)? {
        ensure!(
            std::time::Instant::now() < deadline,
            "daemon did not release its lock"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(())
}

fn wait_ready(paths: &Paths, service: &Service) -> Result<Value> {
    let deadline = std::time::Instant::now() + START_TIMEOUT;
    loop {
        let value = facts(paths);
        if value["running"].as_bool() == Some(true) && value["port"].as_u64().is_some() {
            if let Some(expected) = service.observed()?.pid {
                if value["pid"].as_u64() == Some(u64::from(expected)) {
                    return Ok(value);
                }
            }
        }
        ensure!(
            std::time::Instant::now() < deadline,
            "service did not publish a verified daemon endpoint"
        );
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}
