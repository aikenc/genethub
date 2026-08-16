use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

use crate::artifact::{ArtifactVerifier, SignedArtifact, VerifiedArtifact};
use crate::error::{PlatformError, Result};
use crate::store::ArtifactStore;
use crate::vm::{LogicInstance, LogicVm, VmPolicy};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveOrigin {
    Embedded,
    Installed,
    Recovered,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveLogic {
    pub artifact_id: String,
    pub channel: String,
    pub revision: u64,
    pub platform_abi: u32,
    pub protocol_version: u32,
    pub digest: String,
    pub origin: ActiveOrigin,
}

/// Owns the one durable downloaded artifact and the currently routed Wasm.
///
/// Updating is intentionally a cold application transition: a candidate is
/// verified, booted and health-checked, then published under an exclusive
/// route lock. No guest snapshot, previous slot or automatic rollback exists.
/// The caller must hold the product-level idle/force update gate before calling
/// [`Self::install`].
pub struct PlatformRuntime {
    verifier: ArtifactVerifier,
    vm: LogicVm,
    store: ArtifactStore,
    application_boot: Option<Arc<[u8]>>,
    current: RwLock<Arc<LoadedLogic>>,
    execution: RwLock<()>,
    application_calls: Mutex<()>,
    mutation: Mutex<()>,
}

struct LoadedLogic {
    info: ActiveLogic,
    instance: Arc<LogicInstance>,
}

/// A verified, booted candidate that has not changed durable or routed state.
/// Keeping preparation separate lets the daemon reject a broken download
/// before it terminates any active product work.
pub struct PreparedLogic {
    artifact: VerifiedArtifact,
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

        let fallback_revision = fallback.envelope().logic_revision();
        let mut highest = store.highest_revision()?;
        if fallback_revision > highest {
            // A new App always wins over a downloaded artifact from its older
            // ABI baseline, while the scalar itself can only move forward.
            store.advance_high_water(fallback_revision)?;
            store.discard_active()?;
            store.discard_candidate()?;
            highest = fallback_revision;
        } else if let Err(_candidate_error) = store.recover_candidate() {
            // A staged file is never authoritative by itself. If verification
            // or publication recovery fails, ignore it and select active or
            // the embedded baseline below.
            store.discard_candidate()?;
        }

        let selected = match store.load_active() {
            Ok(Some(artifact))
                if artifact.envelope().logic_revision() == highest
                    && artifact.envelope().logic_revision() >= fallback_revision =>
            {
                prepare_instance(&vm, &artifact, application_boot.as_deref())
                    .ok()
                    .map(|instance| (artifact, Arc::new(instance)))
            }
            Ok(_) | Err(_) => None,
        };

        let loaded = if let Some((artifact, instance)) = selected {
            Arc::new(LoadedLogic {
                info: active_info(&artifact, ActiveOrigin::Installed),
                instance,
            })
        } else {
            // Corruption or a now-incompatible active artifact never lowers
            // the anti-replay fence. The bundled baseline is always allowed.
            let origin = if highest > fallback_revision {
                ActiveOrigin::Recovered
            } else {
                ActiveOrigin::Embedded
            };
            Arc::new(LoadedLogic {
                info: active_info(&fallback, origin),
                instance: fallback_instance,
            })
        };

        Ok(Self {
            verifier,
            vm,
            store,
            application_boot,
            current: RwLock::new(loaded),
            execution: RwLock::new(()),
            application_calls: Mutex::new(()),
            mutation: Mutex::new(()),
        })
    }

    pub fn active(&self) -> Result<ActiveLogic> {
        Ok(self.current_loaded()?.info.clone())
    }

    pub fn highest_accepted_revision(&self) -> Result<u64> {
        self.store.highest_revision()
    }

    /// Verifies, boots and health-checks a candidate before changing durable
    /// or live state. Calls are excluded only for the final single-active
    /// publication; no state is transferred from the old guest.
    pub fn install(&self, candidate: SignedArtifact) -> Result<ActiveLogic> {
        self.activate(self.prepare(candidate)?)
    }

    pub fn prepare(&self, candidate: SignedArtifact) -> Result<PreparedLogic> {
        let artifact = self.verifier.verify(&candidate)?;
        let instance = Arc::new(prepare_instance(
            &self.vm,
            &artifact,
            self.application_boot.as_deref(),
        )?);
        Ok(PreparedLogic { artifact, instance })
    }

    pub fn activate(&self, candidate: PreparedLogic) -> Result<ActiveLogic> {
        let PreparedLogic { artifact, instance } = candidate;
        let _mutation = self
            .mutation
            .lock()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let _execution = self
            .execution
            .write()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let revision = artifact.envelope().logic_revision();
        let highest = self.store.highest_revision()?;
        if revision < highest {
            return Err(PlatformError::RevisionReplay {
                candidate: revision,
                highest,
            });
        }

        self.store.stage(&artifact)?;
        self.store.advance_high_water(revision)?;
        self.store.commit_candidate(revision)?;

        let replacement = Arc::new(LoadedLogic {
            info: active_info(&artifact, ActiveOrigin::Installed),
            instance,
        });
        let info = replacement.info.clone();
        self.replace_current(replacement)?;
        Ok(info)
    }

    pub fn probe(&self, input: i64) -> Result<i64> {
        let _execution = self
            .execution
            .read()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let active = self.current_loaded()?;
        active.instance.probe(input).map_err(|error| {
            PlatformError::Vm(format!(
                "active logic revision {} failed: {error}; install a higher revision",
                active.info.revision
            ))
        })
    }

    pub fn handle(&self, event: &[u8]) -> Result<Vec<u8>> {
        let _execution = self
            .execution
            .read()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let _call = self
            .application_calls
            .lock()
            .map_err(|_| PlatformError::LockPoisoned)?;
        let active = self.current_loaded()?;
        active.instance.handle(event).map_err(|error| {
            PlatformError::Vm(format!(
                "active logic revision {} failed: {error}; install a higher revision",
                active.info.revision
            ))
        })
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

fn active_info(artifact: &VerifiedArtifact, origin: ActiveOrigin) -> ActiveLogic {
    ActiveLogic {
        artifact_id: artifact.artifact_id().to_string(),
        channel: artifact.envelope().channel().to_string(),
        revision: artifact.envelope().logic_revision(),
        platform_abi: artifact.envelope().platform_abi(),
        protocol_version: artifact.envelope().protocol_version(),
        digest: artifact.digest().to_string(),
        origin,
    }
}
