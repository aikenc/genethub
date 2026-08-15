use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use crate::artifact::{ArtifactVerifier, SignedArtifact, VerifiedArtifact};
use crate::error::{PlatformError, Result};
use crate::store::{ArtifactStore, SlotState};
use crate::vm::{LogicInstance, LogicVm, VmPolicy};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveOrigin {
    Embedded,
    Installed,
    Recovered,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveLogic {
    pub generation: u64,
    pub artifact_id: String,
    pub digest: String,
    pub version: String,
    pub origin: ActiveOrigin,
}

/// Owns the durable slots and the currently routed Wasm instance.
///
/// Candidate compilation happens beside the active instance. The active route
/// changes under one short write lock only after signature, ABI and self-check
/// validation and a durable slot commit have all succeeded.
pub struct PlatformRuntime {
    verifier: ArtifactVerifier,
    vm: LogicVm,
    store: ArtifactStore,
    fallback: VerifiedArtifact,
    application_boot: Option<Arc<[u8]>>,
    current: RwLock<Arc<LoadedLogic>>,
    checkpoint: RwLock<Option<Arc<[u8]>>>,
    execution: RwLock<()>,
    application_calls: Mutex<()>,
    mutation: Mutex<()>,
}

struct LoadedLogic {
    info: ActiveLogic,
    instance: Arc<LogicInstance>,
}

impl PlatformRuntime {
    pub fn open(
        root: impl Into<PathBuf>,
        verifier: ArtifactVerifier,
        vm_policy: VmPolicy,
        embedded_fallback: SignedArtifact,
    ) -> Result<Self> {
        Self::open_inner(root, verifier, vm_policy, embedded_fallback, None)
    }

    /// Opens a long-lived application instance. `boot` is an opaque batch
    /// supplied to every candidate before it can receive restored state.
    pub fn open_application(
        root: impl Into<PathBuf>,
        verifier: ArtifactVerifier,
        vm_policy: VmPolicy,
        embedded_fallback: SignedArtifact,
        boot: impl Into<Vec<u8>>,
    ) -> Result<Self> {
        if !vm_policy.require_application_abi {
            return Err(PlatformError::Vm(
                "application runtime requires VmPolicy::application".to_string(),
            ));
        }
        let boot = boot.into();
        if boot.is_empty() {
            return Err(PlatformError::Vm(
                "application boot message must not be empty".to_string(),
            ));
        }
        Self::open_inner(
            root,
            verifier,
            vm_policy,
            embedded_fallback,
            Some(Arc::from(boot)),
        )
    }

    fn open_inner(
        root: impl Into<PathBuf>,
        verifier: ArtifactVerifier,
        vm_policy: VmPolicy,
        embedded_fallback: SignedArtifact,
        application_boot: Option<Arc<[u8]>>,
    ) -> Result<Self> {
        let vm = LogicVm::new(vm_policy)?;
        let fallback = verifier.verify(&embedded_fallback)?;
        let fallback_instance = Arc::new(prepare_instance(
            &vm,
            &fallback,
            application_boot.as_deref(),
        )?);
        let store = ArtifactStore::open(root, verifier.clone())?;
        store.persist(&fallback)?;

        let latest = store.latest_state()?;
        let mut selected = None;
        if let Some(state) = latest.as_ref() {
            selected = try_load(
                &store,
                &vm,
                &state.active_artifact_id,
                application_boot.as_deref(),
            )
            .map(|loaded| {
                let origin = if loaded.0.artifact_id() == fallback.artifact_id() {
                    ActiveOrigin::Embedded
                } else {
                    ActiveOrigin::Installed
                };
                (loaded, origin)
            });
            if selected.is_none() {
                if let Some(previous) = state.previous_artifact_id.as_deref() {
                    selected = try_load(&store, &vm, previous, application_boot.as_deref())
                        .map(|loaded| (loaded, ActiveOrigin::Recovered));
                }
            }
        }

        let ((artifact, instance), origin) = selected.unwrap_or_else(|| {
            (
                (fallback.clone(), fallback_instance),
                if latest.is_some() {
                    ActiveOrigin::Recovered
                } else {
                    ActiveOrigin::Embedded
                },
            )
        });

        let state = match latest {
            Some(state) if state.active_artifact_id == artifact.artifact_id() => state,
            _ => {
                let previous = if artifact.artifact_id() == fallback.artifact_id() {
                    None
                } else {
                    Some(fallback.artifact_id())
                };
                store.commit(artifact.artifact_id(), previous)?
            }
        };
        let loaded = Arc::new(LoadedLogic {
            info: active_info(&state, &artifact, origin),
            instance,
        });
        let checkpoint = if application_boot.is_some() {
            Some(Arc::from(loaded.instance.snapshot()?))
        } else {
            None
        };

        Ok(Self {
            verifier,
            vm,
            store,
            fallback,
            application_boot,
            current: RwLock::new(loaded),
            checkpoint: RwLock::new(checkpoint),
            execution: RwLock::new(()),
            application_calls: Mutex::new(()),
            mutation: Mutex::new(()),
        })
    }

    pub fn active(&self) -> Result<ActiveLogic> {
        Ok(self
            .current
            .read()
            .map_err(|_| PlatformError::LockPoisoned)?
            .info
            .clone())
    }

    /// Verifies and compiles a candidate while the current instance keeps
    /// serving. Only the durable commit and route swap are serialized.
    pub fn install(&self, candidate: SignedArtifact) -> Result<ActiveLogic> {
        let artifact = self.verifier.verify(&candidate)?;
        let instance = Arc::new(prepare_instance(
            &self.vm,
            &artifact,
            self.application_boot.as_deref(),
        )?);
        self.store.persist(&artifact)?;

        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let _execution = self
            .execution
            .write()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let current = self.current_loaded()?;
        let checkpoint = self.transfer_state(&current.instance, &instance)?;
        if current.info.artifact_id == artifact.artifact_id() {
            let replacement = Arc::new(LoadedLogic {
                info: current.info.clone(),
                instance,
            });
            self.replace_current(replacement)?;
            self.replace_checkpoint(checkpoint)?;
            return Ok(current.info.clone());
        }

        let state = self
            .store
            .commit(artifact.artifact_id(), Some(&current.info.artifact_id))?;
        let replacement = Arc::new(LoadedLogic {
            info: active_info(&state, &artifact, ActiveOrigin::Installed),
            instance,
        });
        let info = replacement.info.clone();
        self.replace_current(replacement)?;
        self.replace_checkpoint(checkpoint)?;
        Ok(info)
    }

    pub fn rollback(&self) -> Result<ActiveLogic> {
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let _execution = self
            .execution
            .write()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let current = self.current_loaded()?;
        let state = self
            .store
            .latest_state()?
            .ok_or(PlatformError::NoPreviousArtifact)?;
        if state.active_artifact_id != current.info.artifact_id {
            return Err(PlatformError::State(
                "durable active slot disagrees with the live route".to_string(),
            ));
        }
        let previous = state
            .previous_artifact_id
            .as_deref()
            .ok_or(PlatformError::NoPreviousArtifact)?;
        let (artifact, instance) = try_load(
            &self.store,
            &self.vm,
            previous,
            self.application_boot.as_deref(),
        )
        .ok_or_else(|| {
            PlatformError::State("previous artifact is missing or invalid".to_string())
        })?;
        let checkpoint = self.transfer_state(&current.instance, &instance)?;
        let committed = self
            .store
            .commit(previous, Some(&current.info.artifact_id))?;
        let replacement = Arc::new(LoadedLogic {
            info: active_info(&committed, &artifact, ActiveOrigin::Recovered),
            instance,
        });
        let info = replacement.info.clone();
        self.replace_current(replacement)?;
        self.replace_checkpoint(checkpoint)?;
        Ok(info)
    }

    /// Calls the active guest. A trap poisons that instance and triggers a
    /// best-effort rollback before this error is returned to the caller.
    pub fn probe(&self, input: i64) -> Result<i64> {
        let result = {
            let _execution = self
                .execution
                .read()
                .map_err(|_| PlatformError::LockPoisoned)?;
            let active = self.current_loaded()?;
            (active.clone(), active.instance.probe(input))
        };
        let (active, result) = result;
        match result {
            Ok(output) => Ok(output),
            Err(call_error) => {
                let recovery = self.recover_failed(&active.info.artifact_id);
                let recovery_message = match recovery {
                    Ok(Some(info)) => format!("; recovered to {}", info.version),
                    Ok(None) => "; active route had already changed".to_string(),
                    Err(error) => format!("; automatic recovery failed: {error}"),
                };
                Err(PlatformError::Vm(format!(
                    "active logic {} failed: {call_error}{recovery_message}",
                    active.info.version
                )))
            }
        }
    }

    /// Routes one complete event through the current application instance.
    /// A successful call refreshes the opaque recovery checkpoint. A trap
    /// discards that instance and restores the last checkpoint into the
    /// previous signed artifact without restarting the native process.
    pub fn handle(&self, event: &[u8]) -> Result<Vec<u8>> {
        let result = {
            let _execution = self
                .execution
                .read()
                .map_err(|_| PlatformError::LockPoisoned)?;
            let _call = self
                .application_calls
                .lock()
                .map_err(|_| PlatformError::LockPoisoned)?;
            let active = self.current_loaded()?;
            match active.instance.handle(event) {
                Ok(output) => match active.instance.snapshot() {
                    Ok(snapshot) => {
                        self.replace_checkpoint(Some(Arc::from(snapshot)))?;
                        (active, Ok(output))
                    }
                    Err(error) => (active, Err(error)),
                },
                Err(error) => (active, Err(error)),
            }
        };
        let (active, result) = result;
        match result {
            Ok(output) => Ok(output),
            Err(call_error) => {
                let recovery = self.recover_failed(&active.info.artifact_id);
                let recovery_message = match recovery {
                    Ok(Some(info)) => format!("; recovered to {}", info.version),
                    Ok(None) => "; active route had already changed".to_string(),
                    Err(error) => format!("; automatic recovery failed: {error}"),
                };
                Err(PlatformError::Vm(format!(
                    "active logic {} failed: {call_error}{recovery_message}",
                    active.info.version
                )))
            }
        }
    }

    fn recover_failed(&self, failed_artifact_id: &str) -> Result<Option<ActiveLogic>> {
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let _execution = self
            .execution
            .write()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let current = self.current_loaded()?;
        if current.info.artifact_id != failed_artifact_id {
            return Ok(None);
        }

        let state = self.store.latest_state()?;
        let previous = state
            .as_ref()
            .filter(|state| state.active_artifact_id == failed_artifact_id)
            .and_then(|state| state.previous_artifact_id.as_deref());
        let mut recovered = previous
            .filter(|artifact_id| *artifact_id != failed_artifact_id)
            .and_then(|artifact_id| {
                try_load(
                    &self.store,
                    &self.vm,
                    artifact_id,
                    self.application_boot.as_deref(),
                )
            });
        if recovered.is_none() && self.fallback.artifact_id() != failed_artifact_id {
            recovered = Some((
                self.fallback.clone(),
                Arc::new(prepare_instance(
                    &self.vm,
                    &self.fallback,
                    self.application_boot.as_deref(),
                )?),
            ));
        }
        let Some((artifact, instance)) = recovered else {
            return Err(PlatformError::State(
                "no healthy artifact remains after the active instance failed".to_string(),
            ));
        };
        if let Some(checkpoint) = self.current_checkpoint()? {
            instance.restore(&checkpoint)?;
            instance.health_check()?;
        }
        self.store.persist(&artifact)?;
        let previous = if artifact.artifact_id() == self.fallback.artifact_id() {
            None
        } else {
            Some(self.fallback.artifact_id())
        };
        let committed = self.store.commit(artifact.artifact_id(), previous)?;
        let replacement = Arc::new(LoadedLogic {
            info: active_info(&committed, &artifact, ActiveOrigin::Recovered),
            instance,
        });
        let info = replacement.info.clone();
        self.replace_current(replacement)?;
        Ok(Some(info))
    }

    fn current_loaded(&self) -> Result<Arc<LoadedLogic>> {
        Ok(self
            .current
            .read()
            .map_err(|_| PlatformError::LockPoisoned)?
            .clone())
    }

    fn replace_current(&self, replacement: Arc<LoadedLogic>) -> Result<()> {
        *self
            .current
            .write()
            .map_err(|_| PlatformError::LockPoisoned)? = replacement;
        Ok(())
    }

    fn transfer_state(
        &self,
        current: &LogicInstance,
        candidate: &LogicInstance,
    ) -> Result<Option<Arc<[u8]>>> {
        if self.application_boot.is_none() {
            return Ok(None);
        }
        let snapshot = current.snapshot()?;
        candidate.restore(&snapshot)?;
        candidate.health_check()?;
        Ok(Some(Arc::from(snapshot)))
    }

    fn current_checkpoint(&self) -> Result<Option<Arc<[u8]>>> {
        Ok(self
            .checkpoint
            .read()
            .map_err(|_| PlatformError::LockPoisoned)?
            .clone())
    }

    fn replace_checkpoint(&self, checkpoint: Option<Arc<[u8]>>) -> Result<()> {
        *self
            .checkpoint
            .write()
            .map_err(|_| PlatformError::LockPoisoned)? = checkpoint;
        Ok(())
    }
}

fn try_load(
    store: &ArtifactStore,
    vm: &LogicVm,
    artifact_id: &str,
    boot: Option<&[u8]>,
) -> Option<(VerifiedArtifact, Arc<LogicInstance>)> {
    let artifact = store.load(artifact_id).ok()?;
    let instance = Arc::new(prepare_instance(vm, &artifact, boot).ok()?);
    Some((artifact, instance))
}

fn prepare_instance(
    vm: &LogicVm,
    artifact: &VerifiedArtifact,
    boot: Option<&[u8]>,
) -> Result<LogicInstance> {
    let instance = vm.instantiate(&artifact.component)?;
    if let Some(boot) = boot {
        instance.initialize(boot)?;
        instance.health_check()?;
    }
    Ok(instance)
}

fn active_info(
    state: &SlotState,
    artifact: &VerifiedArtifact,
    origin: ActiveOrigin,
) -> ActiveLogic {
    ActiveLogic {
        generation: state.generation,
        artifact_id: artifact.artifact_id().to_string(),
        digest: artifact.digest().to_string(),
        version: artifact.envelope.version().to_string(),
        origin,
    }
}
