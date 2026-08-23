//! Product Version parsing and ordering for signed component updates.
//!
//! The shape is `epoch.generation.live` with an optional `-tag.N` prerelease:
//! the third digit advances on a Live Release, the middle digit advances (and
//! the third resets to zero) on an App Release. Ordering is total inside one
//! channel and serves as the anti-rollback fence; the bundled App version is
//! the recovery baseline.

use std::cmp::Ordering;
use std::fmt;

use crate::error::{ArtifactError, Result};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProductVersion {
    epoch: u64,
    generation: u64,
    live: u64,
    prerelease: Option<(String, u64)>,
}

impl ProductVersion {
    /// Parses and requires the exact canonical form: no leading zeros, no
    /// empty or extra parts, a lowercase prerelease tag and a positive
    /// prerelease number.
    pub fn parse(raw: &str) -> Result<Self> {
        let (base, prerelease) = match raw.split_once('-') {
            Some((base, suffix)) => {
                let (tag, number) = suffix.split_once('.').ok_or_else(invalid)?;
                if tag.is_empty() || !tag.bytes().all(|byte| byte.is_ascii_lowercase()) {
                    return Err(invalid());
                }
                let number = parse_number(number)?;
                if number == 0 {
                    return Err(invalid());
                }
                (base, Some((tag.to_string(), number)))
            }
            None => (raw, None),
        };
        let parts: Vec<&str> = base.split('.').collect();
        if parts.len() != 3 {
            return Err(invalid());
        }
        let version = Self {
            epoch: parse_number(parts[0])?,
            generation: parse_number(parts[1])?,
            live: parse_number(parts[2])?,
            prerelease,
        };
        if version.to_string() != raw {
            return Err(invalid());
        }
        Ok(version)
    }
}

fn parse_number(raw: &str) -> Result<u64> {
    if raw.is_empty()
        || !raw.bytes().all(|byte| byte.is_ascii_digit())
        || (raw.len() > 1 && raw.starts_with('0'))
    {
        return Err(invalid());
    }
    raw.parse::<u64>().map_err(|_| invalid())
}

fn invalid() -> ArtifactError {
    ArtifactError::EnvelopeField {
        field: "releaseVersion",
        reason: "not a canonical Product Version".to_string(),
    }
}

impl fmt::Display for ProductVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}.{}.{}",
            self.epoch, self.generation, self.live
        )?;
        if let Some((tag, number)) = &self.prerelease {
            write!(formatter, "-{tag}.{number}")?;
        }
        Ok(())
    }
}

impl Ord for ProductVersion {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.epoch, self.generation, self.live)
            .cmp(&(other.epoch, other.generation, other.live))
            .then_with(|| match (&self.prerelease, &other.prerelease) {
                (None, None) => Ordering::Equal,
                // A release supersedes every prerelease of the same base.
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some((tag, number)), Some((other_tag, other_number))) => {
                    tag.cmp(other_tag).then_with(|| number.cmp(other_number))
                }
            })
    }
}

impl PartialOrd for ProductVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_versions() {
        for raw in ["0.1.0", "0.1.2", "10.20.30", "0.2.0-beta.1", "0.0.0-dev.4"] {
            let version = ProductVersion::parse(raw).unwrap();
            assert_eq!(version.to_string(), raw);
        }
    }

    #[test]
    fn rejects_non_canonical_versions() {
        for raw in [
            "",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.03",
            "1.2.3-",
            "1.2.3-beta",
            "1.2.3-beta.0",
            "1.2.3-Beta.1",
            "1.2.3-beta.01",
            "1.2.3-beta.1.2",
            "v1.2.3",
            "1.2.3 ",
        ] {
            assert!(ProductVersion::parse(raw).is_err(), "accepted {raw:?}");
        }
    }

    #[test]
    fn ordering_is_live_then_prerelease() {
        let mut versions = [
            "0.1.10",
            "0.1.2",
            "0.2.0-beta.2",
            "0.2.0",
            "0.2.0-beta.10",
            "0.2.0-beta.1",
            "0.1.9",
        ]
        .into_iter()
        .map(ProductVersion::parse)
        .map(Result::unwrap)
        .collect::<Vec<_>>();
        versions.sort();
        let ordered: Vec<String> = versions.iter().map(ToString::to_string).collect();
        assert_eq!(
            ordered,
            [
                "0.1.2",
                "0.1.9",
                "0.1.10",
                "0.2.0-beta.1",
                "0.2.0-beta.2",
                "0.2.0-beta.10",
                "0.2.0",
            ]
        );
    }
}
