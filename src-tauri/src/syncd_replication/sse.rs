//! Decode complete SSE lines without depending on HTTP chunk boundaries.

#[derive(Default)]
pub(super) struct SseLineDecoder {
    buffer: Vec<u8>,
}

impl SseLineDecoder {
    pub(super) fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut consumed = 0;
        for (index, byte) in self.buffer.iter().enumerate() {
            if *byte == b'\n' {
                let end = if index > consumed && self.buffer[index - 1] == b'\r' {
                    index - 1
                } else {
                    index
                };
                lines.push(
                    std::str::from_utf8(&self.buffer[consumed..end])
                        .map_err(|error| error.to_string())?
                        .to_string(),
                );
                consumed = index + 1;
            }
        }
        self.buffer.drain(..consumed);
        Ok(lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_unicode_and_crlf_preserve_the_original_event() {
        let mut decoder = SseLineDecoder::default();
        let mut lines = Vec::new();
        for byte in "event: change\r\ndata: {\"title\":\"Ação 日本語 📚\"}\r\n\r\n".as_bytes()
        {
            lines.extend(decoder.push(&[*byte]).unwrap());
        }
        assert_eq!(
            lines,
            ["event: change", "data: {\"title\":\"Ação 日本語 📚\"}", ""]
        );
        assert!(decoder.push(&[]).unwrap().is_empty());
    }

    #[test]
    fn incomplete_lines_wait_and_completed_lines_are_not_repeated() {
        let mut decoder = SseLineDecoder::default();
        assert_eq!(
            decoder.push(b"event: ping\ndata: par").unwrap(),
            ["event: ping"]
        );
        assert_eq!(
            decoder.push(b"tial\n\ndata: next\n").unwrap(),
            ["data: partial", "", "data: next"]
        );
    }
}
