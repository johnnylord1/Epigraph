//! Tracker logins in a Suwayomi profile's `settings/tracker.xml`.
//!
//! Suwayomi keeps `TrackerPreferences` in a `java.util.Properties` XML file with the same keys
//! Mihon uses (`pref_mangasync_username_<id>`, `pref_mangasync_password_<id>`, `track_token_<id>`,
//! `track_token_expired_<id>`), so a login stored by one app is the login of the other.
//! Suwayomi loads the file once at startup and rewrites it on every change: reading is safe at
//! any time, writing is only done while that Suwayomi is stopped.
//!
//! Parsing is strict. Anything that is not the shape `Properties.storeToXML` produces is an
//! error, and an unreadable file is never rewritten.

use std::path::{Path, PathBuf};

use super::tracker_credentials::CredentialValues;

const HEADER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\n";

pub fn tracker_prefs_path(profile_root: &Path) -> PathBuf {
    profile_root.join("settings").join("tracker.xml")
}

/// The ordered entries of a profile's tracker preferences; a missing file is empty.
pub fn read_entries(profile_root: &Path) -> Result<Vec<(String, String)>, String> {
    match std::fs::read(tracker_prefs_path(profile_root)) {
        Ok(raw) => parse(&String::from_utf8(raw).map_err(|_| "tracker preferences are not UTF-8")?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("tracker preferences are unreadable: {error}")),
    }
}

fn username_key(tracker_id: i64) -> String {
    format!("pref_mangasync_username_{tracker_id}")
}

fn password_key(tracker_id: i64) -> String {
    format!("pref_mangasync_password_{tracker_id}")
}

fn token_key(tracker_id: i64) -> String {
    format!("track_token_{tracker_id}")
}

fn expired_key(tracker_id: i64) -> String {
    format!("track_token_expired_{tracker_id}")
}

fn value<'a>(entries: &'a [(String, String)], key: &str) -> &'a str {
    entries
        .iter()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
        .unwrap_or("")
}

/// The login of one tracker, or `None` when Suwayomi does not consider it logged in
/// (Mihon's rule: both username and password are set).
pub fn credential(entries: &[(String, String)], tracker_id: i64) -> Option<CredentialValues> {
    let username = value(entries, &username_key(tracker_id));
    let password = value(entries, &password_key(tracker_id));
    if username.is_empty() || password.is_empty() {
        return None;
    }
    Some(CredentialValues {
        username: username.to_string(),
        password: password.to_string(),
        token: value(entries, &token_key(tracker_id)).to_string(),
    })
}

/// Replaces (or with `None` removes) one tracker's login. A written login is not expired,
/// like after `setTrackCredentials`. Returns whether anything changed.
pub fn set_credential(
    entries: &mut Vec<(String, String)>,
    tracker_id: i64,
    login: Option<&CredentialValues>,
) -> bool {
    let before = entries.clone();
    let expired = expired_key(tracker_id);
    entries.retain(|(name, _)| *name != expired);
    for (key, new_value) in [
        (
            username_key(tracker_id),
            login.map(|login| login.username.as_str()),
        ),
        (
            password_key(tracker_id),
            login.map(|login| login.password.as_str()),
        ),
        (
            token_key(tracker_id),
            login.map(|login| login.token.as_str()),
        ),
    ] {
        match new_value.filter(|value| !value.is_empty()) {
            Some(new_value) => match entries.iter_mut().find(|(name, _)| *name == key) {
                Some(entry) => entry.1 = new_value.to_string(),
                None => entries.push((key, new_value.to_string())),
            },
            None => entries.retain(|(name, _)| *name != key),
        }
    }
    *entries != before
}

/// `Properties.storeToXML` shape.
pub fn render(entries: &[(String, String)]) -> Result<String, String> {
    let mut xml = String::from(HEADER);
    xml.push_str("<properties>\n");
    for (key, value) in entries {
        xml.push_str("<entry key=\"");
        xml.push_str(&escape(key)?);
        xml.push_str("\">");
        xml.push_str(&escape(value)?);
        xml.push_str("</entry>\n");
    }
    xml.push_str("</properties>\n");
    Ok(xml)
}

fn escape(text: &str) -> Result<String, String> {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            '\r' | '\n' | '\t' => escaped.push_str(&format!("&#{};", character as u32)),
            character if (character as u32) < 0x20 => {
                return Err("tracker preference value is not representable in XML".to_string())
            }
            character => escaped.push(character),
        }
    }
    Ok(escaped)
}

fn unescape(text: &str) -> Result<String, String> {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        plain.push_str(&rest[..start]);
        let end = rest[start..].find(';').ok_or("unterminated XML entity")? + start;
        let entity = &rest[start + 1..end];
        let character = match entity {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = entity
                    .strip_prefix("#x")
                    .or_else(|| entity.strip_prefix("#X"))
                {
                    u32::from_str_radix(hex, 16)
                } else if let Some(decimal) = entity.strip_prefix('#') {
                    decimal.parse::<u32>()
                } else {
                    return Err("unknown XML entity".to_string());
                };
                code.ok()
                    .and_then(char::from_u32)
                    .ok_or("invalid XML character reference")?
            }
        };
        plain.push(character);
        rest = &rest[end + 1..];
    }
    plain.push_str(rest);
    Ok(plain)
}

fn parse(xml: &str) -> Result<Vec<(String, String)>, String> {
    let malformed = || "tracker preferences are not a Properties XML file".to_string();
    let mut rest = xml.trim_start_matches('\u{feff}').trim_start();
    // Prolog: the XML declaration and the DOCTYPE, in either order of presence.
    for prefix in ["<?xml", "<!DOCTYPE"] {
        if rest.starts_with(prefix) {
            rest = rest[rest.find('>').ok_or_else(malformed)? + 1..].trim_start();
        }
    }
    if let Some(after) = rest.strip_prefix("<properties/>") {
        return if after.trim().is_empty() {
            Ok(Vec::new())
        } else {
            Err(malformed())
        };
    }
    rest = rest.strip_prefix("<properties>").ok_or_else(malformed)?;
    let mut entries = Vec::new();
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("</properties>") {
            return if after.trim().is_empty() {
                Ok(entries)
            } else {
                Err(malformed())
            };
        }
        if let Some(after) = rest.strip_prefix("<comment>") {
            rest = &after[after.find("</comment>").ok_or_else(malformed)? + "</comment>".len()..];
            continue;
        }
        if rest.starts_with("<comment/>") {
            rest = &rest["<comment/>".len()..];
            continue;
        }
        let after = rest
            .strip_prefix("<entry")
            .ok_or_else(malformed)?
            .trim_start();
        let after = after.strip_prefix("key=").ok_or_else(malformed)?;
        let quote = after
            .chars()
            .next()
            .filter(|quote| matches!(quote, '"' | '\''))
            .ok_or_else(malformed)?;
        let after = &after[1..];
        let key_end = after.find(quote).ok_or_else(malformed)?;
        let key = unescape(&after[..key_end])?;
        let after = after[key_end + 1..].trim_start();
        if let Some(after) = after.strip_prefix("/>") {
            entries.push((key, String::new()));
            rest = after;
            continue;
        }
        let after = after.strip_prefix('>').ok_or_else(malformed)?;
        let value_end = after.find("</entry>").ok_or_else(malformed)?;
        let raw_value = &after[..value_end];
        if raw_value.contains('<') {
            return Err(malformed());
        }
        entries.push((key, unescape(raw_value)?));
        rest = &after[value_end + "</entry>".len()..];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(token: &str) -> CredentialValues {
        CredentialValues {
            username: "user & co".to_string(),
            password: "p<a>ss\"'".to_string(),
            token: token.to_string(),
        }
    }

    #[test]
    fn parses_java_store_to_xml_output() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\r\n\
<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">\r\n\
<properties>\r\n<comment>saved</comment>\r\n\
<entry key=\"score_type_2\">POINT_100</entry>\r\n\
<entry key=\"pref_mangasync_username_1\">a&amp;b&#233;&#x41;</entry>\r\n\
<entry key=\"empty\"/>\r\n</properties>\r\n";
        let entries = parse(xml).unwrap();
        assert_eq!(
            entries,
            vec![
                ("score_type_2".to_string(), "POINT_100".to_string()),
                ("pref_mangasync_username_1".to_string(), "a&béA".to_string()),
                ("empty".to_string(), String::new()),
            ]
        );
        assert!(parse("<properties/>").unwrap().is_empty());
    }

    #[test]
    fn refuses_anything_else() {
        for xml in [
            "",
            "<properties>",
            "<properties><entry key=\"a\">1</entry>",
            "<properties><entry key=\"a\"><b/></entry></properties>",
            "<properties><foo/></properties>",
            "<properties><entry key=\"a\">&bogus;</entry></properties>",
            "<properties></properties>trailing",
        ] {
            assert!(parse(xml).is_err(), "{xml}");
        }
    }

    #[test]
    fn writes_and_reads_back_logins_keeping_other_entries() {
        let mut entries = vec![
            ("score_type_2".to_string(), "POINT_100".to_string()),
            ("track_token_expired_7".to_string(), "true".to_string()),
        ];
        assert!(credential(&entries, 7).is_none());
        assert!(set_credential(
            &mut entries,
            7,
            Some(&login("{\"access_token\":\"x\"}"))
        ));
        assert!(!set_credential(
            &mut entries,
            7,
            Some(&login("{\"access_token\":\"x\"}"))
        ));
        let reparsed = parse(&render(&entries).unwrap()).unwrap();
        assert_eq!(reparsed, entries);
        assert_eq!(
            credential(&reparsed, 7),
            Some(login("{\"access_token\":\"x\"}"))
        );
        assert!(reparsed
            .iter()
            .all(|(key, _)| key != "track_token_expired_7"));
        assert!(reparsed.contains(&("score_type_2".to_string(), "POINT_100".to_string())));

        let mut logged_out = reparsed.clone();
        assert!(set_credential(&mut logged_out, 7, None));
        assert_eq!(
            logged_out,
            vec![("score_type_2".to_string(), "POINT_100".to_string())]
        );
        assert!(!set_credential(&mut logged_out, 7, None));
    }

    #[test]
    fn a_login_needs_username_and_password() {
        let entries = vec![
            ("pref_mangasync_username_3".to_string(), "u".to_string()),
            ("track_token_3".to_string(), "t".to_string()),
        ];
        assert!(credential(&entries, 3).is_none());
        assert!(format!(
            "{:?}",
            credential(
                &[
                    ("pref_mangasync_username_3".to_string(), "u".to_string()),
                    (
                        "pref_mangasync_password_3".to_string(),
                        "secret".to_string()
                    ),
                ],
                3
            )
        )
        .find("secret")
        .is_none());
    }
}
