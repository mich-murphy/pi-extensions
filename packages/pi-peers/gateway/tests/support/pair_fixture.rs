//! Shared isolated native CLI fixtures.
use serde_json::{Value, json};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(1);
pub(crate) struct Fixture(pub(crate) PathBuf);
impl Fixture {
    pub(crate) fn new() -> Self {
        let path = std::env::temp_dir()
            .canonicalize()
            .expect("owned pairing fixture")
            .join(format!(
                "pi-p-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        fs::create_dir(&path).expect("owned pairing fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
            .expect("owned pairing fixture");
        Self(path)
    }
    pub(crate) fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    pub(crate) fn run(&self, op: &str, input: &Value) -> Output {
        let path = self.path("input.json");
        fs::write(
            &path,
            serde_json::to_vec(input).expect("owned pairing fixture"),
        )
        .expect("owned pairing fixture");
        Command::new(env!("CARGO_BIN_EXE_pi-gateway"))
            .args(["pair", op, "--input"])
            .arg(path)
            .output()
            .expect("owned pairing fixture")
    }
    pub(crate) fn ok(&self, op: &str, input: &Value) -> Value {
        let output = self.run(op, input);
        assert!(
            output.status.success(),
            "{op}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).expect("owned pairing fixture")
    }
    pub(crate) fn create(&self) -> Value {
        self.ok("create", &json!({"issuerDir":self.path("issuer"),"runtimeDir":self.path("alpha"),"machineId":"alpha","peerMachineId":"beta"}))
    }
    pub(crate) fn joined(&self) -> (Value, Value) {
        let creator = self.create();
        let joined = self.ok("join", &json!({"runtimeDir":self.path("beta"),"offerPath":creator["offerPath"],"confirmedRootSha256":creator["rootSha256"]}));
        (creator, joined)
    }
    pub(crate) fn issued(&self) -> (Value, Value, Value) {
        let (creator, joined) = self.joined();
        let issued = self.ok("issue", &json!({"issuerDir":self.path("issuer"),"requestPath":joined["requestPath"],"confirmedRequestSha256":joined["requestSha256"]}));
        let alpha = self.ok("import", &json!({"runtimeDir":self.path("alpha"),"bundlePath":issued["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"existing"}));
        let beta = self.ok("import", &json!({"runtimeDir":self.path("beta"),"bundlePath":issued["bundlePath"],"confirmedRootSha256":creator["rootSha256"],"floorMode":"new"}));
        (creator, alpha, beta)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).expect("owned pairing fixture");
    }
}
