//! Stateful property: per-link `PeerRef` interning round-trips, stays bounded and never lets a
//! number survive into a new link generation.
use pi_gateway::intern::Refs;
use serde_json::{Value, json};

mod support;

fn peer(machine: &str, n: u16) -> Value {
    json!({"machineId":machine,"sessionId":format!("s{n}"),"runtimeNonce":format!("{n:032x}")})
}

#[derive(Debug, Clone, Copy)]
enum Step {
    Export(u16),
    Import(u16),
    Send(u16, u16),
    Reconnect,
}

fn draw_step(tc: &hegel::TestCase) -> Step {
    use hegel::generators as gs;
    let n = || tc.draw(gs::integers::<u16>().min_value(0).max_value(40));
    match tc.draw(gs::integers::<u8>().min_value(0).max_value(9)) {
        0..=2 => Step::Export(n()),
        3..=5 => Step::Import(n()),
        6..=8 => Step::Send(n(), n()),
        _ => Step::Reconnect,
    }
}

/// Two ends of one link: alpha's export table mirrors beta's import table and vice versa.
struct Link {
    alpha: Refs,
    beta: Refs,
    cap: usize,
}
impl Link {
    fn new(cap: usize) -> Self {
        Self {
            alpha: Refs::new(cap),
            beta: Refs::new(cap),
            cap,
        }
    }
    fn apply(&mut self, step: Step) {
        match step {
            Step::Export(n) => {
                self.alpha.exported(&peer("alpha", n));
                self.beta.imported(&peer("alpha", n));
            }
            Step::Import(n) => {
                self.beta.exported(&peer("beta", n));
                self.alpha.imported(&peer("beta", n));
            }
            Step::Send(from, to) => self.send(from, to),
            Step::Reconnect => {
                let stale = self.compressed(0, 0);
                *self = Self::new(self.cap);
                let mut probe = stale;
                if probe["from"].is_u64() || probe["to"].is_u64() {
                    assert!(
                        self.beta.expand(&mut probe).is_err(),
                        "a number from the previous link generation is refused"
                    );
                }
            }
        }
        let (exported, imported) = self.alpha.sizes();
        assert!(
            exported <= self.cap && imported <= self.cap,
            "tables stay bounded"
        );
        assert_eq!(
            self.alpha.sizes(),
            (self.beta.sizes().1, self.beta.sizes().0),
            "each end's export table mirrors the other end's import table"
        );
    }
    fn compressed(&self, from: u16, to: u16) -> Value {
        let mut frame = json!({"v":2,"op":"send","from":peer("alpha", from),"to":peer("beta", to)});
        self.alpha.compress(&mut frame);
        frame
    }
    fn send(&self, from: u16, to: u16) {
        let mut frame = self.compressed(from, to);
        self.beta
            .expand(&mut frame)
            .expect("every number alpha sends is known to beta");
        assert_eq!(frame["from"], peer("alpha", from), "from round-trips");
        assert_eq!(frame["to"], peer("beta", to), "to round-trips");
    }
}

#[hegel::test(support::property_settings(300, 31_415))]
fn interning_round_trips_is_bounded_and_resets_per_link(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let cap = tc.draw(gs::integers::<usize>().min_value(1).max_value(16));
    let mut link = Link::new(cap);
    let count = tc.draw(gs::integers::<usize>().min_value(0).max_value(120));
    for _ in 0..count {
        link.apply(draw_step(&tc));
    }
}

#[test]
fn a_number_never_assigned_is_refused() {
    let refs = Refs::default();
    let mut frame = json!({"from":0,"to":peer("beta", 1)});
    assert!(refs.expand(&mut frame).is_err());
}

#[test]
fn interning_shrinks_a_cross_machine_send() {
    let mut refs = Refs::default();
    refs.exported(&peer("alpha", 1));
    refs.imported(&peer("beta", 2));
    let mut frame = json!({"from":peer("alpha", 1),"to":peer("beta", 2)});
    let before = frame.to_string().len();
    refs.compress(&mut frame);
    assert_eq!(frame, json!({"from":0,"to":0}));
    assert!(frame.to_string().len() + 100 < before);
}
