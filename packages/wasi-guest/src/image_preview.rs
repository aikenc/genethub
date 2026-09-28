//! Non-blocking image worker handle for the single guest fiber.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::time::Duration;

use crate::poll::idle;
use crate::wit::genehub::host::image_preview as host;

thread_local! {
    static JOBS: RefCell<HashMap<u64, host::Job>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u64> = const { Cell::new(1) };
}

pub struct ImageResult {
    pub bytes: Vec<u8>,
    pub media_type: String,
    pub width: u32,
    pub height: u32,
}

struct Job(u64);

impl Drop for Job {
    fn drop(&mut self) {
        JOBS.with_borrow_mut(|jobs| jobs.remove(&self.0));
    }
}

pub async fn resize(bytes: Vec<u8>, edge: u16, timeout: Duration) -> Result<ImageResult, String> {
    let resource = host::resize(&bytes, edge)?;
    let id = NEXT.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    });
    JOBS.with_borrow_mut(|jobs| jobs.insert(id, resource));
    let _job = Job(id);
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let result = JOBS.with_borrow(|jobs| jobs.get(&id).expect("image job registered").poll());
        if let Some(result) = result? {
            return Ok(ImageResult {
                bytes: result.bytes,
                media_type: result.media_type,
                width: result.width,
                height: result.height,
            });
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("image preview timed out".into());
        }
        idle().await;
    }
}
