//! Settings shared by every Hegel property in the gateway tests.
//!
//! Without environment variables a property runs its own case count from its own fixed seed, so the
//! pull-request gate is deterministic. `HEGEL_SEED` replaces the seed and `HEGEL_TEST_CASES` the case
//! count for every property, as in the TypeScript helper `test-support/hegel-settings.ts`. The crate
//! would ignore these variables for a property that pins its own seed, so they are read here.

use hegel::{Database, Settings};

/// Parses `HEGEL_SEED`: unset or empty keeps `default`, anything but an integer in [0, 2^64) fails.
pub(crate) fn parse_seed(raw: Option<&str>, default: u64) -> Result<u64, String> {
    match raw {
        None | Some("") => Ok(default),
        Some(text) if text.bytes().all(|byte| byte.is_ascii_digit()) => text
            .parse()
            .map_err(|_| format!("HEGEL_SEED must be an integer in [0, 2^64), got {text:?}")),
        Some(text) => Err(format!(
            "HEGEL_SEED must be an integer in [0, 2^64), got {text:?}"
        )),
    }
}

/// Parses `HEGEL_TEST_CASES`: unset or empty keeps `default`, anything but a positive integer fails.
pub(crate) fn parse_test_cases(raw: Option<&str>, default: u64) -> Result<u64, String> {
    match raw {
        None | Some("") => Ok(default),
        Some(text) if text.bytes().all(|byte| byte.is_ascii_digit()) => match text.parse::<u64>() {
            Ok(cases) if cases > 0 => Ok(cases),
            _ => Err(format!(
                "HEGEL_TEST_CASES must be a positive integer, got {text:?}"
            )),
        },
        Some(text) => Err(format!(
            "HEGEL_TEST_CASES must be a positive integer, got {text:?}"
        )),
    }
}

/// Prints the seed and case count. libtest shows captured output with a failure, so they reach the log.
#[expect(
    clippy::print_stderr,
    reason = "the seed must appear in a failing run's output"
)]
fn announce(seed: u64, test_cases: u64) {
    eprintln!("Hegel property: HEGEL_SEED={seed} HEGEL_TEST_CASES={test_cases}");
}

/// Settings for one property. An invalid variable fails the property with a message naming it. The
/// seed and case count are printed first, so libtest shows them with any failure, next to the blob
/// Hegel prints. The failure database stays off: a counterexample becomes a regression test.
pub(crate) fn property_settings(default_cases: u64, default_seed: u64) -> Settings {
    let resolve = || -> Result<(u64, u64), String> {
        Ok((
            parse_seed(std::env::var("HEGEL_SEED").ok().as_deref(), default_seed)?,
            parse_test_cases(
                std::env::var("HEGEL_TEST_CASES").ok().as_deref(),
                default_cases,
            )?,
        ))
    };
    let (seed, test_cases) = resolve().unwrap_or_else(|message| panic!("{message}"));
    announce(seed, test_cases);
    Settings::new()
        .test_cases(test_cases)
        .seed(Some(seed))
        .database(Database::Disabled)
        .print_blob(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_defaults_when_unset_or_empty() {
        assert_eq!(parse_seed(None, 7), Ok(7));
        assert_eq!(parse_seed(Some(""), 7), Ok(7));
    }

    #[test]
    fn seed_accepts_the_whole_u64_range() {
        assert_eq!(parse_seed(Some("0"), 7), Ok(0));
        assert_eq!(parse_seed(Some("42"), 7), Ok(42));
        assert_eq!(parse_seed(Some("18446744073709551615"), 7), Ok(u64::MAX));
    }

    #[test]
    fn seed_rejects_everything_else() {
        for bad in [
            "18446744073709551616",
            "random",
            "none",
            "-1",
            "1.5",
            " 1",
            "0x10",
            "1e3",
        ] {
            let message = parse_seed(Some(bad), 7).expect_err(bad);
            assert!(message.contains("HEGEL_SEED"), "{message}");
            assert!(message.contains(bad), "{message}");
        }
    }

    #[test]
    fn test_cases_defaults_when_unset_or_empty() {
        assert_eq!(parse_test_cases(None, 200), Ok(200));
        assert_eq!(parse_test_cases(Some(""), 200), Ok(200));
    }

    #[test]
    fn test_cases_accepts_positive_integers() {
        assert_eq!(parse_test_cases(Some("1"), 200), Ok(1));
        assert_eq!(parse_test_cases(Some("2000"), 200), Ok(2000));
    }

    #[test]
    fn test_cases_rejects_everything_else() {
        for bad in [
            "0",
            "00",
            "-5",
            "2.5",
            "many",
            " 3",
            "99999999999999999999999",
        ] {
            let message = parse_test_cases(Some(bad), 200).expect_err(bad);
            assert!(message.contains("HEGEL_TEST_CASES"), "{message}");
            assert!(message.contains(bad), "{message}");
        }
    }
}
