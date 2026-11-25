//! Wire v2 refuses v1 frames, except the one upgrade-path control request: a local
//! `gateway.restart`, so a running older gateway can be stopped and a newer one can be.
use pi_gateway::wire::{Role, decode_body};
use serde_json::{Value, json};

const RID: &str = "11111111111111111111111111111111";
const NONCE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("fixture JSON")
}
fn at(version: u64, mut frame: Value) -> Value {
    frame["v"] = json!(version);
    frame["rid"] = json!(RID);
    frame
}
fn peer(machine: &str) -> Value {
    json!({"machineId":machine,"sessionId":"s","runtimeNonce":NONCE})
}
fn message() -> Value {
    json!({"id":RID,"kind":"request","content":"hi","format":"text"})
}

#[test]
fn a_v1_gateway_restart_is_accepted_only_from_a_local_client() {
    let restart = at(
        1,
        json!({"op":"gateway.restart","expectedMachineId":"alpha"}),
    );
    assert!(
        decode_body(&bytes(&restart), Role::LocalClient).is_ok(),
        "the upgrade path: a v1 restart request stops this gateway"
    );
    for role in [
        Role::RemoteLink,
        Role::GatewayForward,
        Role::AdapterDelivery,
    ] {
        assert!(
            decode_body(&bytes(&restart), role).is_err(),
            "{role:?} never accepts a restart"
        );
    }
    let acknowledgement = at(
        1,
        json!({"op":"result","forOp":"gateway.restart","outcome":{"tag":"ok","value":{}}}),
    );
    assert!(
        decode_body(&bytes(&acknowledgement), Role::LocalClient).is_err(),
        "only the request is exempt, not a v1 result"
    );
    assert!(
        decode_body(&bytes(&at(0, restart)), Role::LocalClient).is_err(),
        "no other old version"
    );
}

#[test]
fn every_other_v1_frame_is_refused() {
    let local = [
        json!({"op":"register","sessionId":"s","runtimeNonce":NONCE,"scopeIds":["team"],"label":"Pi"}),
        json!({"op":"close"}),
        json!({"op":"discover","scopeIds":["team"],"watch":false}),
        json!({"op":"unwatch","watchRid":RID}),
        json!({"op":"send","to":peer("beta"),"scopeId":"team","budgetMs":15000,"message":message()}),
        json!({"op":"result","forOp":"close","outcome":{"tag":"ok","value":{}}}),
        json!({"op":"roster.event","event":{"tag":"remove","peer":peer("beta")}}),
    ];
    let remote = [
        json!({"op":"ping"}),
        json!({"op":"send","from":peer("alpha"),"to":peer("beta"),"scopeId":"team","budgetMs":15000,"message":message()}),
    ];
    let delivery = [
        json!({"op":"deliver","from":peer("alpha"),"to":peer("beta"),"scopeId":"team","budgetMs":15000,"message":message()}),
        json!({"op":"link.state","machineId":"beta","state":"up","since":1}),
    ];
    for (role, frames) in [
        (Role::LocalClient, &local[..]),
        (Role::RemoteLink, &remote[..]),
        (Role::AdapterDelivery, &delivery[..]),
    ] {
        for frame in frames {
            assert!(
                decode_body(&bytes(&at(2, frame.clone())), role).is_ok(),
                "v2 {frame} is valid at {role:?}"
            );
            assert!(
                decode_body(&bytes(&at(1, frame.clone())), role).is_err(),
                "v1 {frame} is refused at {role:?}"
            );
        }
    }
}
