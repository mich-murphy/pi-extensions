//! Operator configuration has no implicit grants or remote fallback.
use pi_gateway::config::Config;
use serde_json::{Value, json};

fn valid() -> Value {
    json!({"machineId":"alpha","socketPath":"/private/tmp/not-bound","scopeIds":["team"],"policies":[{"machineId":"alpha","scopeId":"team","permissions":["discover","read","push","interest"]}]})
}
#[test]
fn explicit_config_accepts_unique_bounded_permission_enums() {
    assert!(Config::parse(&serde_json::to_vec(&valid()).unwrap()).is_ok());
    let mut value = valid();
    value["policies"] = json!([]);
    assert!(
        Config::parse(&serde_json::to_vec(&value).unwrap()).is_ok(),
        "empty policy denies all operations rather than silently granting them"
    );
}
#[test]
fn unknown_duplicate_and_ambiguous_policy_is_rejected() {
    let mut invalid = Vec::new();
    let mut value = valid();
    value["remote"] = json!({"address":"127.0.0.1:1"});
    invalid.push(value);
    let mut value = valid();
    value["scopeIds"] = json!(["team", "team"]);
    invalid.push(value);
    let mut value = valid();
    value["policies"][0]["permissions"] = json!(["push", "push"]);
    invalid.push(value);
    let mut value = valid();
    value["policies"][0]["permissions"] = json!(["admin"]);
    invalid.push(value);
    let mut value = valid();
    value["policies"][0]["push"] = json!(true);
    invalid.push(value);
    let mut value = valid();
    value["policies"][0]["scopeId"] = json!("unconfigured");
    invalid.push(value);
    let mut value = valid();
    value["policies"] = json!([value["policies"][0], value["policies"][0]]);
    invalid.push(value);
    let mut value = valid();
    value["machineId"] = json!("Alpha");
    invalid.push(value);
    let mut value = valid();
    value["socketPath"] = json!("relative.sock");
    invalid.push(value);
    for (index, value) in invalid.iter().enumerate() {
        assert!(
            Config::parse(&serde_json::to_vec(value).unwrap()).is_err(),
            "invalid configuration case {index}"
        );
    }
    assert!(Config::parse(br#"{"machineId":"alpha","machineId":"beta"}"#).is_err());
    assert!(Config::parse(br#"{"machineId":null}"#).is_err());
}

#[test]
fn directional_grants_are_independent_and_default_outgoing_remains_compatible() {
    let mut config = valid();
    let outgoing = config["policies"][0].clone();
    let mut incoming = outgoing.clone();
    incoming["direction"] = json!("incoming");
    config["policies"] = json!([outgoing, incoming]);
    assert!(Config::parse(&serde_json::to_vec(&config).unwrap()).is_ok());
    config["policies"][1]["direction"] = json!("outgoing");
    assert!(
        Config::parse(&serde_json::to_vec(&config).unwrap()).is_err(),
        "omitted outgoing and explicit outgoing are the same tuple"
    );
    config["policies"][1]["direction"] = json!("both");
    assert!(
        Config::parse(&serde_json::to_vec(&config).unwrap()).is_err(),
        "no implicit bidirectional grant"
    );
}
