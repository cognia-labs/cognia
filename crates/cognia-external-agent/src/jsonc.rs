//! Bounded JSONC (JSON with comments and trailing commas).
use serde_json::{Map, Value};

/// The largest JSONC document accepted.
pub const MAX_JSONC_BYTES: usize = 1_048_576;
const MAX_JSON_BYTES: usize = MAX_JSONC_BYTES;
const INVALID: &str = "not a valid bounded JSONC object";

/// Parse a bounded JSONC object without changing quoted string contents.
/// Shared by engine configuration files and environment builds, so decoded
/// substitutions are validated before any external CLI can resolve them.
pub fn parse_jsonc(raw: &str) -> Result<Map<String, Value>, String> {
    if raw.len() > MAX_JSON_BYTES {
        return Err(INVALID.into());
    }
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut string = false;
    while i < bytes.len() {
        let ch = bytes[i];
        if string {
            out.push(ch);
            if ch == b'\\' {
                i += 1;
                if i < bytes.len() {
                    out.push(bytes[i]);
                }
            } else if ch == b'"' {
                string = false;
            }
        } else if ch == b'"' {
            string = true;
            out.push(ch);
        } else if ch == b'/' && bytes.get(i + 1) == Some(&b'/') {
            while i + 1 < bytes.len() && bytes[i + 1] != b'\n' {
                i += 1;
            }
            out.push(b' ');
        } else if ch == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            if i + 1 >= bytes.len() {
                return Err(INVALID.into());
            }
            i += 1;
            out.push(b' ');
        } else {
            out.push(ch);
        }
        i += 1;
    }
    let mut cleaned = Vec::with_capacity(out.len());
    i = 0;
    string = false;
    while i < out.len() {
        let ch = out[i];
        if string {
            cleaned.push(ch);
            if ch == b'\\' {
                i += 1;
                if i < out.len() {
                    cleaned.push(out[i]);
                }
            } else if ch == b'"' {
                string = false;
            }
        } else if ch == b'"' {
            string = true;
            cleaned.push(ch);
        } else {
            if ch != b','
                || !matches!(
                    out[i + 1..].iter().find(|byte| !byte.is_ascii_whitespace()),
                    Some(b'}' | b']')
                )
            {
                cleaned.push(ch);
            }
        }
        i += 1;
    }
    serde_json::from_slice::<Value>(&cleaned)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| INVALID.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comments_and_trailing_commas_go_but_string_contents_stay() {
        assert_eq!(
            parse_jsonc(r#"{/*c*/"text":"a,} // literal", // tail
            }"#)
            .unwrap()["text"],
            "a,} // literal"
        );
        assert!(parse_jsonc("[1]").is_err());
        assert!(parse_jsonc("{/* open").is_err());
        assert!(parse_jsonc(&" ".repeat(MAX_JSONC_BYTES + 1)).is_err());
    }
}
