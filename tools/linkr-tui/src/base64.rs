//! Base64 encode/decode, matching `web/target_files.js` byte for byte.
//!
//! The encoder and decoder live here (not on some platform `base64`) so the
//! same code runs everywhere and the decoder can refuse anything `base64 -d`
//! would refuse. The decoder only runs on text that already passed the charset
//! and length checks in the caller that parses the device's reply.

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode bytes as standard padded base64.
pub fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied().unwrap_or(0);
        let c = chunk.get(2).copied().unwrap_or(0);
        out.push(B64_ALPHABET[(a >> 2) as usize] as char);
        out.push(B64_ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_ALPHABET[(c & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn b64_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decode padded base64. Only called with text that already passed the charset
/// and length checks, so this returns `None` on any malformed input rather than
/// guessing.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let padding = if bytes.ends_with(b"==") {
        2
    } else if bytes.ends_with(b"=") {
        1
    } else {
        0
    };
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3 - padding);
    for quad in bytes.chunks(4) {
        let a = b64_value(quad[0])?;
        let b = b64_value(quad[1])?;
        let c = if quad[2] == b'=' {
            0
        } else {
            b64_value(quad[2])?
        };
        let d = if quad[3] == b'=' {
            0
        } else {
            b64_value(quad[3])?
        };
        out.push((a << 2) | (b >> 4));
        if quad[2] != b'=' {
            out.push(((b & 15) << 4) | (c >> 2));
        }
        if quad[3] != b'=' {
            out.push(((c & 3) << 6) | d);
        }
    }
    Some(out)
}

/// Whether text is well-formed padded base64: length a multiple of four, only
/// alphabet characters, and padding only at the end.
pub fn is_valid_base64(text: &str) -> bool {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(4) {
        return false;
    }
    let mut seen_padding = false;
    for &b in bytes {
        if b == b'=' {
            seen_padding = true;
        } else if seen_padding || b64_value(b).is_none() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_the_rfc_examples() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn round_trips_arbitrary_bytes() {
        for data in [
            &b"hello world"[..],
            b"\x00\x01\x02\xff\xfe",
            &b"binary\x00data\x1b"[..],
            &[0x00u8, 0xff, 0x80, 0x7f],
        ] {
            let enc = encode_base64(data);
            assert_eq!(decode_base64(&enc).as_deref(), Some(data));
        }
    }

    #[test]
    fn decoder_matches_encoder_length() {
        // base64 turns 3 bytes into 4 characters.
        assert_eq!(encode_base64(&[0; 1024]).len(), 1368);
        assert_eq!(
            decode_base64(&encode_base64(&[0; 1024])).unwrap().len(),
            1024
        );
    }

    #[test]
    fn validates_charset_and_padding() {
        assert!(is_valid_base64("Zm9v"));
        assert!(is_valid_base64("Zg=="));
        assert!(is_valid_base64(""));
        assert!(!is_valid_base64("Zm9v=")); // wrong padding
        assert!(!is_valid_base64("Zm9")); // not a multiple of four
        assert!(!is_valid_base64("Zm9!")); // bad character
        assert!(!is_valid_base64("Z==g")); // padding in the middle
    }

    #[test]
    fn decode_refuses_malformed_input() {
        assert_eq!(decode_base64("Zm9"), None);
        assert_eq!(decode_base64("Zm9!"), None);
    }
}
