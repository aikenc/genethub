//! Fabric uplink stub for the WASI guest. Native implementation stays in
//! `fabric.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::config::Enrollment;
use crate::state::Shared;

pub struct FabricUplink {
    online: Arc<AtomicBool>,
}

impl FabricUplink {
    pub fn start(_state: Shared, _enrollment: Enrollment) -> Self {
        Self {
            online: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start_rendezvous(_state: Shared, _url: String) -> Self {
        Self {
            online: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.online.store(false, Ordering::Relaxed);
    }
}
