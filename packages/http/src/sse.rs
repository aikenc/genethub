//! Incremental SSE data framing shared by HTTP consumers.
//! Follows the HTML event-stream interpretation rules; callers interpret data.
pub struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    skip_lf: bool,
    first_line: bool,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self {
            line: Vec::new(),
            data: Vec::new(),
            skip_lf: false,
            first_line: true,
        }
    }

    /// Preserve raw bytes until a complete line, including UTF-8 split across
    /// transport chunks. Incomplete events at EOF are deliberately discarded.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        let mut events = Vec::new();
        for &byte in chunk {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if byte == b'\r' || byte == b'\n' {
                self.skip_lf = byte == b'\r';
                self.end_line(&mut events);
            } else {
                self.line.push(byte);
            }
        }
        events
    }

    fn end_line(&mut self, events: &mut Vec<String>) {
        let mut line = std::mem::take(&mut self.line);
        if self.first_line {
            self.first_line = false;
            if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                line.drain(..3);
            }
        }
        if line.is_empty() {
            if !self.data.is_empty() {
                self.data.pop(); // The final newline is framing, not data.
                events.push(String::from_utf8_lossy(&self.data).into_owned());
                self.data.clear();
            }
            return;
        }
        let split = line
            .iter()
            .position(|&byte| byte == b':')
            .unwrap_or(line.len());
        if &line[..split] != b"data" {
            return;
        }
        let mut value = if split < line.len() {
            &line[split + 1..]
        } else {
            &[]
        };
        if value.first() == Some(&b' ') {
            value = &value[1..];
        }
        self.data.extend_from_slice(value);
        self.data.push(b'\n');
    }
}

impl Default for SseDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_byte_split_preserves_unicode_crlf_bom_and_multiline_data() {
        let bytes = "\u{feff}: ping\r\nevent: message\r\ndata: 来自🌱\r\ndata:  第二行\r\n\r\ndata: [DONE]\r\r".as_bytes();
        for split in 0..=bytes.len() {
            let mut decoder = SseDecoder::new();
            let mut events = decoder.push(&bytes[..split]);
            events.extend(decoder.push(&bytes[split..]));
            assert_eq!(events, ["来自🌱\n 第二行", "[DONE]"], "split {split}");
        }
        let mut decoder = SseDecoder::new();
        let events: Vec<_> = bytes
            .iter()
            .flat_map(|byte| decoder.push(&[*byte]))
            .collect();
        assert_eq!(events, ["来自🌱\n 第二行", "[DONE]"]);
    }

    #[test]
    fn empty_data_dispatches_but_partial_event_and_unknown_fields_do_not() {
        let mut decoder = SseDecoder::new();
        assert_eq!(decoder.push(b"retry: 10\nid: 1\ndata\n\n"), [""]);
        assert!(decoder.push(b"data: unfinished\n").is_empty());
        assert_eq!(decoder.push(b"\n"), ["unfinished"]);
        assert!(decoder.push(b"data: eof").is_empty());
    }
}
