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
    current: RwLock<Arc<LoadedLogic>>,
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
        let vm = LogicVm::new(vm_policy)?;
        let fallback = verifier.verify(&embedded_fallback)?;
        let fallback_instance = Arc::new(vm.instantiate(&fallback.component)?);
        let store = ArtifactStore::open(root, verifier.clone())?;
        store.persist(&fallback)?;

        let latest = store.latest_state()?;
        let mut selected = None;
        if let Some(state) = latest.as_ref() {
            selected = try_load(&store, &vm, &state.active_artifact_id).map(|loaded| {
                let origin = if loaded.0.artifact_id() == fallback.artifact_id() {
                    ActiveOrigin::Embedded
                } else {
                    ActiveOrigin::Installed
                };
                (loaded, origin)
            });
            if selected.is_none() {
                if let Some(previous) = state.previous_artifact_id.as_deref() {
                    selected = try_load(&store, &vm, previous)
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

        Ok(Self {
            verifier,
            vm,
            store,
            fallback,
            current: RwLock::new(loaded),
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
        let instance = Arc::new(self.vm.instantiate(&artifact.component)?);
        self.store.persist(&artifact)?;

        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let current = self.current_loaded()?;
        if current.info.artifact_id == artifact.artifact_id() {
            let replacement = Arc::new(LoadedLogic {
                info: current.info.clone(),
                instance,
            });
            self.replace_current(replacement)?;
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
        Ok(info)
    }

    pub fn rollback(&self) -> Result<ActiveLogic> {
        let _mutation = self
            .mutation
            .lock()
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
        let (artifact, instance) = try_load(&self.store, &self.vm, previous).ok_or_else(|| {
            PlatformError::State("previous artifact is missing or invalid".to_string())
        })?;
        let committed = self
            .store
            .commit(previous, Some(&current.info.artifact_id))?;
        let replacement = Arc::new(LoadedLogic {
            info: active_info(&committed, &artifact, ActiveOrigin::Recovered),
            instance,
        });
        let info = replacement.info.clone();
        self.replace_current(replacement)?;
        Ok(info)
    }

    /// Calls the active guest. A trap poisons that instance and triggers a
    /// best-effort rollback before this error is returned to the caller.
    pub fn probe(&self, input: i64) -> Result<i64> {
        let active = self.current_loaded()?;
        match active.instance.probe(input) {
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
            .and_then(|artifact_id| try_load(&self.store, &self.vm, artifact_id));
        if recovered.is_none() && self.fallback.artifact_id() != failed_artifact_id {
            recovered = Some((
                self.fallback.clone(),
                Arc::new(self.vm.instantiate(&self.fallback.component)?),
            ));
        }
        let Some((artifact, instance)) = recovered else {
            return Err(PlatformError::State(
                "no healthy artifact remains after the active instance failed".to_string(),
            ));
        };
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
}

fn try_load(
    store: &ArtifactStore,
    vm: &LogicVm,
    artifact_id: &str,
) -> Option<(VerifiedArtifact, Arc<LogicInstance>)> {
    let artifact = store.load(artifact_id).ok()?;
    let instance = Arc::new(vm.instantiate(&artifact.component).ok()?);
    Some((artifact, instance))
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
