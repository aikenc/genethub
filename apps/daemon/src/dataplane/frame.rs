use anyhow::{anyhow, Result};

pub const HEADER_BYTES: usize = 16;
pub const SECURE_RECORD_HEADER_BYTES: usize = 12;
pub const SECURE_RECORD_TAG_BYTES: usize = 16;
pub const MAX_PAYLOAD_BYTES: usize = genehub_proto::MAX_DATA_FRAME_BYTES
    - SECURE_RECORD_HEADER_BYTES
    - SECURE_RECORD_TAG_BYTES
    - HEADER_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Open = 1,
    Head = 2,
    Data = 3,
    WindowUpdate = 4,
    Fin = 5,
    Reset = 6,
    Ping = 7,
    Pong = 8,
}

impl TryFrom<u8> for Kind {
    type Error = anyhow::Error;

    fn try_from(value: u8) -> Result<Self> {
        Ok(match value {
            1 => Self::Open,
            2 => Self::Head,
            3 => Self::Data,
            4 => Self::WindowUpdate,
            5 => Self::Fin,
            6 => Self::Reset,
            7 => Self::Ping,
            8 => Self::Pong,
            _ => return Err(anyhow!("unknown data frame kind")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: Kind,
    pub stream_id: u32,
    pub value: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.payload.len() > MAX_PAYLOAD_BYTES {
            return Err(anyhow!("data frame payload exceeds the 16 KiB wire limit"));
        }
        if matches!(self.kind, Kind::Ping | Kind::Pong) != (self.stream_id == 0) {
            return Err(anyhow!("only endpoint control frames use stream zero"));
        }
        let mut wire = Vec::with_capacity(HEADER_BYTES + self.payload.len());
        wire.push(genehub_proto::DATA_PLANE_VERSION as u8);
        wire.push(self.kind as u8);
        wire.extend_from_slice(&0u16.to_be_bytes());
        wire.extend_from_slice(&self.stream_id.to_be_bytes());
        wire.extend_from_slice(&self.value.to_be_bytes());
        wire.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        wire.extend_from_slice(&self.payload);
        Ok(wire)
    }

    pub fn decode(wire: &[u8]) -> Result<Self> {
        if wire.len() < HEADER_BYTES
            || wire[0] != genehub_proto::DATA_PLANE_VERSION as u8
            || u16::from_be_bytes(wire[2..4].try_into().unwrap()) != 0
        {
            return Err(anyhow!("invalid data frame header"));
        }
        let kind = Kind::try_from(wire[1])?;
        let stream_id = u32::from_be_bytes(wire[4..8].try_into().unwrap());
        let value = u32::from_be_bytes(wire[8..12].try_into().unwrap());
        let length = u32::from_be_bytes(wire[12..16].try_into().unwrap()) as usize;
        if length > MAX_PAYLOAD_BYTES || HEADER_BYTES + length != wire.len() {
            return Err(anyhow!("invalid data frame payload length"));
        }
        if matches!(kind, Kind::Ping | Kind::Pong) != (stream_id == 0) {
            return Err(anyhow!("invalid data frame control stream"));
        }
        Ok(Self {
            kind,
            stream_id,
            value,
            payload: wire[HEADER_BYTES..].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_web_binary_golden_vector() {
        let frame = Frame {
            kind: Kind::Data,
            stream_id: 0x0102_0304,
            value: 0x0506_0708,
            payload: b"abc".to_vec(),
        };
        assert_eq!(
            frame.encode().unwrap(),
            vec![3, 3, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0, 3, b'a', b'b', b'c']
        );
        assert_eq!(Frame::decode(&frame.encode().unwrap()).unwrap(), frame);
    }

    #[test]
    fn secure_wire_budget_is_exact() {
        let frame = Frame {
            kind: Kind::Data,
            stream_id: 1,
            value: 1,
            payload: vec![0; MAX_PAYLOAD_BYTES],
        };
        assert_eq!(
            frame.encode().unwrap().len() + SECURE_RECORD_HEADER_BYTES + SECURE_RECORD_TAG_BYTES,
            genehub_proto::MAX_DATA_FRAME_BYTES
        );
    }
}
