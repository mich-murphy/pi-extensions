//! Stateful property: the link breaker never latches, backs off within bounds and reports every
//! transition exactly once.
use std::time::Duration;

use pi_gateway::breaker::{Breaker, LinkView, PROBE_MAX, PROBE_MIN};
use tokio::time::Instant;

mod support;

#[derive(Debug, Clone, Copy)]
enum Step {
    ConnectOk,
    ConnectFail(u64),
    Advance(u64),
    LocalRegister,
    Disconnect,
    Send,
}

fn draw_step(tc: &hegel::TestCase) -> Step {
    use hegel::generators as gs;
    match tc.draw(gs::integers::<u8>().min_value(0).max_value(5)) {
        0 => Step::ConnectOk,
        1 => Step::ConnectFail(tc.draw(gs::integers::<u64>())),
        2 => Step::Advance(tc.draw(gs::integers::<u64>().min_value(0).max_value(400_000))),
        3 => Step::LocalRegister,
        4 => Step::Disconnect,
        _ => Step::Send,
    }
}

struct Model {
    breaker: Breaker,
    now: Instant,
    in_flight: bool,
}
impl Model {
    fn observe(&mut self, before: LinkView, reported: Option<LinkView>) {
        let after = self.breaker.view();
        assert_eq!(
            reported,
            (before != after).then_some(after),
            "a state event is emitted exactly on a transition"
        );
        if reported.is_some() {
            assert_eq!(
                self.breaker.since(),
                self.now,
                "since moves with the transition"
            );
        }
    }
    fn start_due(&mut self) {
        if self.in_flight {
            return;
        }
        let before = self.breaker.view();
        let (started, reported) = self.breaker.attempt(self.now);
        self.observe(before, reported);
        self.in_flight = started;
    }
    fn apply(&mut self, step: Step) {
        let before = self.breaker.view();
        match step {
            Step::Advance(milliseconds) => {
                self.now += Duration::from_millis(milliseconds);
            }
            Step::ConnectOk if self.in_flight => {
                self.in_flight = false;
                let reported = self.breaker.connected(self.now);
                self.observe(before, reported);
            }
            Step::ConnectFail(random) if self.in_flight => {
                self.in_flight = false;
                let reported = self.breaker.failed(self.now, random);
                self.observe(before, reported);
                if let Some(probe) = self.breaker.next_probe() {
                    let delay = probe - self.now;
                    assert!(
                        (PROBE_MIN..=PROBE_MAX).contains(&delay),
                        "probe backoff {delay:?} within [30 s, 5 min]"
                    );
                }
            }
            Step::LocalRegister => {
                self.breaker.local_registration(self.now);
                self.observe(before, None);
            }
            Step::Disconnect if before == LinkView::Up || self.in_flight => {
                self.in_flight = false;
                let reported = self.breaker.failed(self.now, 0);
                self.observe(before, reported);
            }
            Step::Send => {
                assert_eq!(
                    self.breaker.fails_fast(),
                    self.breaker.view() != LinkView::Up,
                    "sends fail fast exactly while no link is up"
                );
            }
            Step::ConnectOk | Step::ConnectFail(_) | Step::Disconnect => {}
        }
        self.start_due();
        if self.breaker.view() != LinkView::Up && !self.in_flight {
            assert!(
                self.breaker.due().is_some(),
                "a connector without a link always has a next attempt"
            );
        }
    }
    fn recovers(&mut self) {
        if self.breaker.view() == LinkView::Up {
            self.apply(Step::Disconnect);
        }
        let deadline = self.now + PROBE_MAX + Duration::from_secs(120);
        while !self.in_flight {
            let due = self.breaker.due().expect("never latched");
            assert!(due <= deadline, "next attempt within the backoff cap");
            self.now = self.now.max(due);
            self.start_due();
        }
        self.apply(Step::ConnectOk);
        assert_eq!(
            self.breaker.view(),
            LinkView::Up,
            "a successful handshake closes it"
        );
    }
}

#[hegel::test(support::property_settings(300, 61_803))]
fn breaker_never_latches_and_reports_each_transition(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let now = Instant::now();
    let mut model = Model {
        breaker: Breaker::connecting(now),
        now,
        in_flight: false,
    };
    model.start_due();
    let count = tc.draw(gs::integers::<usize>().min_value(0).max_value(80));
    for _ in 0..count {
        let step = draw_step(&tc);
        model.apply(step);
    }
    model.recovers();
}

#[test]
fn many_failures_still_recover() {
    let now = Instant::now();
    let mut model = Model {
        breaker: Breaker::connecting(now),
        now,
        in_flight: false,
    };
    model.start_due();
    for _ in 0..500 {
        model.apply(Step::ConnectFail(u64::MAX));
        model.apply(Step::Advance(400_000));
    }
    assert!(model.breaker.is_open() || model.in_flight);
    model.recovers();
}
