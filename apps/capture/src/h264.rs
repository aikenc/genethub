//! H.264 facts Capture can verify itself: the level that the configured
//! picture size/rate needs, and what the encoder's first SPS actually says.
//! The SDP `profile-level-id` is derived from the former and checked against
//! the latter, so an offer/answer pair never silently drifts from the stream.

/// (level_idc, MaxMBPS, MaxFS, MaxBR in kbit/s) for Baseline/Main/Extended,
/// ITU-T H.264 Table A-1. Level 1b is intentionally omitted.
const LEVELS: &[(u8, u32, u32, u32)] = &[
    (10, 1_485, 99, 64),
    (11, 3_000, 396, 192),
    (12, 6_000, 396, 384),
    (13, 11_880, 396, 768),
    (20, 11_880, 396, 2_000),
    (21, 19_800, 792, 4_000),
    (22, 20_250, 1_620, 4_000),
    (30, 40_500, 1_620, 10_000),
    (31, 108_000, 3_600, 14_000),
    (32, 216_000, 5_120, 20_000),
    (40, 245_760, 8_192, 20_000),
    (41, 245_760, 8_192, 50_000),
    (42, 522_240, 8_704, 50_000),
    (50, 589_824, 22_080, 135_000),
    (51, 983_040, 36_864, 240_000),
    (52, 2_073_600, 36_864, 240_000),
];

/// Lowest level able to carry `width`x`height` at `fps` and `kbps`.
/// `None` means the profile is outside the supported table.
pub fn level_for(width: u32, height: u32, fps: u32, kbps: u32) -> Option<u8> {
    let (mb_w, mb_h) = (width.div_ceil(16).max(1), height.div_ceil(16).max(1));
    let frame = mb_w * mb_h;
    let rate = u64::from(frame) * u64::from(fps);
    LEVELS
        .iter()
        .find(|(_, max_mbps, max_fs, max_br)| {
            let dimension = ((8 * max_fs) as f64).sqrt() as u32;
            frame <= *max_fs
                && rate <= u64::from(*max_mbps)
                && kbps <= *max_br
                && mb_w <= dimension
                && mb_h <= dimension
        })
        .map(|(level, ..)| *level)
}

/// `profile-level-id` for Constrained Baseline (42e0) at `level_idc`.
pub fn profile_level_id(level_idc: u8) -> String {
    format!("42e0{level_idc:02x}")
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Sps {
    pub profile_idc: u8,
    pub constraint_flags: u8,
    pub level_idc: u8,
    /// Cropped output size; `None` for profiles whose SPS needs the extended
    /// chroma/scaling syntax that Capture does not produce.
    pub size: Option<(u32, u32)>,
}

struct Bits<'a> {
    data: &'a [u8],
    position: usize,
}
impl<'a> Bits<'a> {
    fn bit(&mut self) -> Option<u32> {
        let byte = *self.data.get(self.position / 8)?;
        let value = (byte >> (7 - self.position % 8)) & 1;
        self.position += 1;
        Some(u32::from(value))
    }
    fn bits(&mut self, count: u32) -> Option<u32> {
        let mut value = 0;
        for _ in 0..count {
            value = (value << 1) | self.bit()?;
        }
        Some(value)
    }
    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return None;
            }
        }
        Some(if zeros == 0 {
            0
        } else {
            (1u32 << zeros) - 1 + self.bits(zeros)?
        })
    }
    fn se(&mut self) -> Option<i64> {
        let value = i64::from(self.ue()?);
        Some(if value & 1 == 1 {
            (value + 1) / 2
        } else {
            -(value / 2)
        })
    }
}

fn nal_units(stream: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut index = 0;
    while index + 3 <= stream.len() {
        if stream[index] == 0 && stream[index + 1] == 0 && stream[index + 2] == 1 {
            starts.push(index + 3);
            index += 3;
        } else {
            index += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, start)| {
            let mut end = starts.get(n + 1).map_or(stream.len(), |next| next - 3);
            while end > *start && stream[end - 1] == 0 {
                end -= 1;
            }
            &stream[*start..end]
        })
        .collect()
}

/// Parse the first SPS NAL unit of an Annex-B access unit.
pub fn parse_sps(stream: &[u8]) -> Option<Sps> {
    let nal = nal_units(stream)
        .into_iter()
        .find(|nal| !nal.is_empty() && nal[0] & 0x1f == 7)?;
    // Remove emulation-prevention bytes (00 00 03).
    let mut rbsp = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for byte in &nal[1..] {
        if zeros >= 2 && *byte == 3 {
            zeros = 0;
            continue;
        }
        zeros = if *byte == 0 { zeros + 1 } else { 0 };
        rbsp.push(*byte);
    }
    if rbsp.len() < 4 {
        return None;
    }
    let (profile_idc, constraint_flags, level_idc) = (rbsp[0], rbsp[1], rbsp[2]);
    let mut sps = Sps {
        profile_idc,
        constraint_flags,
        level_idc,
        size: None,
    };
    if ![66, 77, 88].contains(&profile_idc) {
        return Some(sps);
    }
    let mut bits = Bits {
        data: &rbsp[3..],
        position: 0,
    };
    let size = (|| {
        bits.ue()?; // seq_parameter_set_id
        bits.ue()?; // log2_max_frame_num_minus4
        match bits.ue()? {
            0 => {
                bits.ue()?;
            }
            1 => {
                bits.bit()?;
                bits.se()?;
                bits.se()?;
                for _ in 0..bits.ue()?.min(255) {
                    bits.se()?;
                }
            }
            _ => {}
        }
        bits.ue()?; // max_num_ref_frames
        bits.bit()?; // gaps_in_frame_num_value_allowed_flag
        let width_mbs = bits.ue()? + 1;
        let height_map_units = bits.ue()? + 1;
        let frame_mbs_only = bits.bit()?;
        if frame_mbs_only == 0 {
            bits.bit()?; // mb_adaptive_frame_field_flag
        }
        bits.bit()?; // direct_8x8_inference_flag
        let (mut left, mut right, mut top, mut bottom) = (0, 0, 0, 0);
        if bits.bit()? == 1 {
            left = bits.ue()?;
            right = bits.ue()?;
            top = bits.ue()?;
            bottom = bits.ue()?;
        }
        let unit_y = 2 * (2 - frame_mbs_only);
        let width = (width_mbs * 16).checked_sub(2 * (left + right))?;
        let height =
            (height_map_units * (2 - frame_mbs_only) * 16).checked_sub(unit_y * (top + bottom))?;
        Some((width, height))
    })();
    sps.size = size;
    Some(sps)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_cover_the_supported_capture_profiles() {
        assert_eq!(level_for(1280, 720, 30, 4_000), Some(31));
        assert_eq!(level_for(1920, 1080, 30, 8_000), Some(40));
        assert_eq!(level_for(1920, 1080, 60, 8_000), Some(42));
        assert_eq!(level_for(1920, 1080, 30, 30_000), Some(41));
        assert_eq!(level_for(3840, 2160, 30, 20_000), Some(51));
        assert_eq!(level_for(3840, 2160, 60, 20_000), Some(52));
        assert_eq!(level_for(7680, 4320, 120, 50_000), None);
        assert_eq!(profile_level_id(40), "42e028");
    }

    // 1920x1080 Constrained Baseline level 4.0 SPS as produced by hardware
    // encoders: 1088 coded rows, cropped by 8.
    #[test]
    fn parses_baseline_1080p_sps_with_cropping() {
        let stream = [
            0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x28, 0xda, 0x01, 0xe0, 0x08, 0x9f, 0x95, 0, 0, 0, 1,
            0x68, 0xce, 0x3c, 0x80,
        ];
        let sps = parse_sps(&stream).expect("sps");
        assert_eq!(
            (sps.profile_idc, sps.constraint_flags, sps.level_idc),
            (66, 0xc0, 40)
        );
        assert_eq!(sps.size, Some((1920, 1080)));
    }

    #[test]
    fn rejects_streams_without_an_sps_and_flags_high_profile() {
        assert!(parse_sps(&[0, 0, 0, 1, 0x65, 1, 2, 3]).is_none());
        assert!(parse_sps(&[]).is_none());
        let high = [0, 0, 1, 0x67, 100, 0, 40, 0xda, 1, 2];
        let sps = parse_sps(&high).expect("sps");
        assert_eq!((sps.profile_idc, sps.level_idc, sps.size), (100, 40, None));
    }
}
