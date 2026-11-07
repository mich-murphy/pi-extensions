//! Exact shared byte corpus; fixture bytes are never reserialized before validation.
use std::fs;
use std::path::Path;

use pi_session_gateway::wire::{self, Role};
use serde_json::Value;

#[test]
fn shared_wire_corpus() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    let manifest: Value =
        serde_json::from_slice(&fs::read(directory.join("manifest.json")).unwrap()).unwrap();
    for case in manifest["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let role = match case["role"].as_str().unwrap_or("local-client") {
            "local-client" => Role::LocalClient,
            "remote-link" => Role::RemoteLink,
            "gateway-forward" => Role::GatewayForward,
            "adapter-delivery" => Role::AdapterDelivery,
            other => panic!("unknown fixture role {other}"),
        };
        let hex = fs::read_to_string(directory.join(case["hexFile"].as_str().unwrap())).unwrap();
        let hex: String = hex
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        assert_eq!(hex.len() % 2, 0, "fixture {name} byte encoding");
        let bytes: Vec<u8> = hex
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect();
        let result = if case["boundary"] == "json" {
            wire::decode_json(&bytes, role)
        } else {
            wire::decode_frame(&bytes, role)
        };
        if case["expected"]["tag"] == "accepted" {
            assert!(result.is_ok(), "fixture {name} must be accepted");
            assert_eq!(
                result.unwrap(),
                case["expected"]["value"],
                "fixture {name} typed value"
            );
        } else {
            assert!(result.is_err(), "fixture {name} must be rejected");
        }
    }
}
