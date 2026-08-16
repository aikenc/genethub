use genehub_proto::{ErrorCode, ProtocolError};
use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityFailure, CapabilityFailureKind, CapabilityRequest,
    CapabilityResult, CapabilityValue,
};

use crate::CapabilityExecutor;

pub struct Client<'a, E> {
    executor: &'a mut E,
    next: &'a mut u64,
}

impl<'a, E: CapabilityExecutor> Client<'a, E> {
    pub fn new(executor: &'a mut E, next: &'a mut u64) -> Self {
        Self { executor, next }
    }

    pub fn call(&mut self, request: CapabilityRequest) -> Result<CapabilityValue, ProtocolError> {
        self.call_raw(request)?.map_err(map_failure)
    }

    pub fn call_raw(
        &mut self,
        request: CapabilityRequest,
    ) -> Result<Result<CapabilityValue, CapabilityFailure>, ProtocolError> {
        let call_id = self.id();
        let batch_id = self.id();
        let output = self
            .executor
            .execute(CapabilityBatch {
                batch_id,
                calls: vec![CapabilityCall { call_id, request }],
            })
            .map_err(|message| ProtocolError {
                code: ErrorCode::Internal,
                message,
            })?;
        if output.batch_id != batch_id {
            return Err(internal("capability result has the wrong batch id"));
        }
        match output.results.as_slice() {
            [CapabilityResult {
                call_id: returned,
                result,
            }] if *returned == call_id => Ok(result.clone()),
            _ => Err(internal("capability result is malformed")),
        }
    }

    fn id(&mut self) -> u64 {
        let id = *self.next;
        *self.next = self.next.saturating_add(1);
        id
    }
}

fn map_failure(error: CapabilityFailure) -> ProtocolError {
    ProtocolError {
        code: match error.kind {
            CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
            CapabilityFailureKind::Denied => ErrorCode::Forbidden,
            CapabilityFailureKind::NotFound => ErrorCode::NotFound,
            CapabilityFailureKind::Conflict => ErrorCode::Conflict,
            CapabilityFailureKind::Unavailable
            | CapabilityFailureKind::TooLarge
            | CapabilityFailureKind::Internal => ErrorCode::Internal,
        },
        message: error.message,
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}
