//! The serial journal (`web/serial_journal.js`): a bounded ring of received
//! device bytes, kept separate from local echo, UI text and assistant text.
//!
//! The retained window is kept as the *chunks* that produced it, so rebuilding
//! one string per append never copies the whole ring. `start` skips the evicted
//! head; `length` counts retained characters; `end` is the running total, which
//! is what makes cursors directly comparable across evictions. Control bytes
//! are masked to NUL as they arrive, before paging or eviction can split a
//! sequence, so a cursor survives any eviction.

/// The default retained capacity, matching the web's 128 KiB.
pub const DEFAULT_CAPACITY: usize = 128 * 1024;

/// The default page size for a `read`.
pub const DEFAULT_LIMIT: usize = 12_000;

/// The maximum page size a read will honour.
pub const MAX_LIMIT: usize = 16_000;

/// A bounded serial log with cursor-based paging.
#[derive(Debug, Clone, Default)]
pub struct SerialJournal {
    capacity: usize,
    parts: Vec<String>,
    start: usize,
    length: usize,
    end: usize,
}

/// One page of the journal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalPage {
    /// The page text, control bytes already dropped.
    pub text: String,
    /// The cursor the page starts at.
    pub start: usize,
    /// The cursor the page ends at.
    pub cursor: usize,
    /// The journal's current end cursor.
    pub latest_cursor: usize,
    /// Whether history before the requested start was evicted.
    pub truncated: bool,
}

impl SerialJournal {
    /// A new, empty journal with the given capacity (defaults to 128 KiB).
    pub fn new(capacity: usize) -> Self {
        SerialJournal {
            capacity,
            parts: Vec::new(),
            start: 0,
            length: 0,
            end: 0,
        }
    }

    /// The journal's current end cursor (total characters ever received).
    pub fn latest_cursor(&self) -> usize {
        self.end
    }

    /// The number of characters currently retained.
    pub fn retained(&self) -> usize {
        self.length
    }

    /// Append decoded text, masking control bytes to NUL. This mirrors the
    /// web's `append` for already-decoded UTF-8; use [`SerialJournal::append_bytes`]
    /// when feeding raw bytes.
    pub fn append(&mut self, text: &str) {
        self.end += text.chars().count();
        let mut visible = String::with_capacity(text.len());
        for ch in text.chars() {
            // Tab, CR and LF are the only controls kept; the rest are masked to
            // NUL (`is_control` covers U+0000..U+001F and U+007F..U+009F).
            let keep = if ch == '\t' || ch == '\r' || ch == '\n' {
                true
            } else {
                !ch.is_control()
            };
            visible.push(if keep { ch } else { '\0' });
        }
        if !visible.is_empty() {
            self.parts.push(visible);
            self.length += self.parts.last().map(|p| p.chars().count()).unwrap_or(0);
            self.evict();
        }
    }

    /// Drop from the head until the window fits, never starting on a low
    /// surrogate that would surface as a replacement character.
    fn evict(&mut self) {
        while self.length > self.capacity {
            if self.start >= self.parts.len() {
                self.length = 0;
                break;
            }
            let head = self.parts[self.start].clone();
            if head.is_empty() {
                self.start += 1;
                continue;
            }
            let excess = self.length - self.capacity;
            let head_len = head.chars().count();
            if head_len <= excess {
                self.length -= head_len;
                self.parts[self.start] = String::new();
                self.start += 1;
            } else {
                // Keep the tail of the chunk, dropping `excess` characters from
                // its head — the web's `head.slice(excess)`.
                self.parts[self.start] = head.chars().skip(excess).collect();
                self.length -= excess;
            }
            if self.start > 256 {
                self.parts.drain(0..self.start);
                self.start = 0;
            }
        }
    }

    /// Read a page from the tail of the ring. `after` is a cursor offset; when
    /// omitted, the page is the last `limit` characters. Returns the text with
    /// control bytes stripped.
    pub fn read(&self, after: Option<usize>, limit: usize) -> JournalPage {
        let limit = limit.clamp(1, MAX_LIMIT);
        let oldest = self.end - self.length;
        let requested = after.unwrap_or_else(|| self.end.saturating_sub(limit));
        let start = self.end.min(oldest.max(requested));
        let end = self.end.min(start + limit);
        let text = self.page(start - oldest, end - start).replace('\0', "");
        JournalPage {
            text,
            start,
            cursor: end,
            latest_cursor: self.end,
            truncated: requested < oldest,
        }
    }

    /// Collect `count` characters ending at offset `from` into the retained
    /// text (the tail of the ring). `from` is an offset into the retained text;
    /// `need` counts back to it.
    fn page(&self, from: usize, count: usize) -> String {
        if count == 0 {
            return String::new();
        }
        let mut need = self.length - from;
        if need == 0 {
            return String::new();
        }
        let mut text = String::new();
        let mut i = self.parts.len();
        while i > self.start && need > 0 {
            i -= 1;
            let part = &self.parts[i];
            if part.is_empty() {
                continue;
            }
            let part_len = part.chars().count();
            let take: String = if part_len > need {
                part.chars().skip(part_len - need).collect()
            } else {
                part.clone()
            };
            need -= take.chars().count();
            text = take + &text;
        }
        let chars: Vec<char> = text.chars().take(count).collect();
        chars.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_reads_back() {
        let mut j = SerialJournal::new(DEFAULT_CAPACITY);
        j.append("hello ");
        j.append("world");
        assert_eq!(j.latest_cursor(), 11);
        let page = j.read(None, DEFAULT_LIMIT);
        assert_eq!(page.text, "hello world");
        assert_eq!(page.cursor, 11);
        assert!(!page.truncated);
    }

    #[test]
    fn masks_control_bytes_but_keeps_whitespace() {
        let mut j = SerialJournal::new(DEFAULT_CAPACITY);
        j.append("a\x07b\tc\r\nd");
        let page = j.read(None, DEFAULT_LIMIT);
        assert_eq!(page.text, "ab\tc\r\nd");
    }

    #[test]
    fn evicts_beyond_capacity() {
        let mut j = SerialJournal::new(10);
        j.append("123456789012345");
        assert!(j.retained() <= 10);
        let page = j.read(None, DEFAULT_LIMIT);
        assert_eq!(
            page.text, "6789012345",
            "the head is evicted, the tail kept"
        );
        assert!(page.truncated);
    }

    #[test]
    fn paging_by_cursor_is_stable_across_eviction() {
        let mut j = SerialJournal::new(100);
        j.append("0123456789");
        let first = j.read(None, DEFAULT_LIMIT);
        assert_eq!(first.text, "0123456789");
        j.append("abcdef");
        // Read only what arrived after cursor 10.
        let second = j.read(Some(10), DEFAULT_LIMIT);
        assert_eq!(second.text, "abcdef");
        assert_eq!(second.start, 10);
    }

    #[test]
    fn a_read_never_returns_more_than_the_limit() {
        let mut j = SerialJournal::new(DEFAULT_CAPACITY);
        j.append("abcdefghijklmnopqrstuvwxyz");
        let page = j.read(None, 5);
        assert_eq!(page.text, "vwxyz");
        assert_eq!(page.cursor - page.start, 5);
    }

    #[test]
    fn an_empty_journal_reads_empty() {
        let j = SerialJournal::new(DEFAULT_CAPACITY);
        let page = j.read(None, DEFAULT_LIMIT);
        assert_eq!(page.text, "");
        assert_eq!(page.cursor, 0);
    }

    #[test]
    fn multi_byte_characters_are_not_split_by_paging() {
        let mut j = SerialJournal::new(DEFAULT_CAPACITY);
        j.append("中文测试数据");
        let page = j.read(None, 4);
        assert_eq!(page.text.chars().count(), 4);
        assert_eq!(page.text, "测试数据");
    }
}
