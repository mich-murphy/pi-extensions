//! Authenticated own-machine roster exchange and directional two-host routing.
use std::io;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::{
    Client, Daemon, MAX_CONNECTIONS, Refresh, Remote, Step, Watch, encoded_length, member, project,
    random_id,
};
use crate::breaker::LinkView;
use crate::budget::{BufferClass, ConnectionId, ConnectionKind};
use crate::caps::Verb;
use crate::config::Permission;
use crate::remote::Authenticated;
use crate::replies::{Answer, Full};
use crate::tailscale::{Failure, Peer};
use crate::transport::{self, Charge, Event, SourceEpoch};

const PING_AFTER: Duration = Duration::from_secs(30);
const CLOSE_AFTER: Duration = Duration::from_secs(90);
/// How often a linked peer's identity and caps are asked for again.
pub(super) const REFRESH_EVERY: Duration = Duration::from_secs(15);
/// Consecutive failed refreshes that close the link.
const REFRESH_FAILURES: u8 = 2;

impl Daemon {
    pub(super) fn is_remote(&self, id: ConnectionId) -> bool {
        self.clients
            .get(&id)
            .is_some_and(|client| client.remote.is_some())
    }
    pub(super) fn remote_id(&self) -> Option<ConnectionId> {
        self.clients
            .iter()
            .find(|(_, client)| {
                client.remote.as_ref().is_some()
                    && client.source.active()
                    && !client.failed
                    && !client.closing
            })
            .map(|(id, _)| *id)
    }
    pub(super) fn remote_descriptor(&self, id: ConnectionId, peer: &Value) -> Option<&Value> {
        self.clients
            .get(&id)?
            .remote
            .as_ref()?
            .roster
            .iter()
            .find(|(descriptor, _, _)| descriptor["peer"] == *peer)
            .map(|(descriptor, _, _)| descriptor)
    }
    pub(super) fn all_descriptors(&self) -> Vec<&Value> {
        self.clients
            .values()
            .filter(|client| !client.failed && !client.closing)
            .flat_map(|client| {
                client.descriptor.iter().chain(
                    client.remote.iter().flat_map(|remote| {
                        remote.roster.iter().map(|(descriptor, _, _)| descriptor)
                    }),
                )
            })
            .collect()
    }
    pub(super) fn discovery_projection(
        &self,
        id: ConnectionId,
        descriptor: &Value,
        scopes: &[String],
    ) -> Option<Value> {
        let machine = descriptor["peer"]["machineId"].as_str()?;
        let scopes: Vec<_> = scopes
            .iter()
            .filter(|scope| {
                if self.is_remote(id) {
                    machine == self.config.machine_id
                        && self.remote_allows(id, scope, Verb::Discover)
                } else if machine == self.config.machine_id {
                    self.config.permits(machine, scope, Permission::Discover)
                } else {
                    // Imported from the remote, which already filtered by what it grants us.
                    true
                }
            })
            .cloned()
            .collect();
        project(descriptor, &scopes)
    }
    /// What the linked remote `id` may do here, from the caps tailscaled last reported.
    pub(super) fn remote_allows(&self, id: ConnectionId, scope: &str, verb: Verb) -> bool {
        self.clients
            .get(&id)
            .and_then(|client| client.remote.as_ref())
            .is_some_and(|remote| remote.peer.caps.allows(scope, verb))
    }
    /// Whether a frame from remote `id` may reach a local session in `scope`: anything under
    /// `push`; under `reply` only a `reply`, or an `update` with `replyTo`, answering a message
    /// a local session sent that remote on this link. An admitted answer is counted at once.
    pub(super) fn remote_admits(&mut self, id: ConnectionId, request: &Value, scope: &str) -> bool {
        if self.remote_allows(id, scope, Verb::Push) {
            return true;
        }
        let message = &request["message"];
        let answer = match (message["kind"].as_str(), message.get("replyTo")) {
            (Some("reply"), Some(_)) => Answer::Reply,
            (Some("update"), Some(_)) => Answer::Update,
            _ => return false,
        };
        if !self.remote_allows(id, scope, Verb::Reply)
            || message["replyTo"]["sender"] != request["to"]
        {
            return false;
        }
        let Some(message_id) = message["replyTo"]["messageId"].as_str() else {
            return false;
        };
        self.clients
            .get_mut(&id)
            .and_then(|client| client.remote.as_mut())
            .is_some_and(|remote| {
                remote.replies.answer(
                    &request["from"],
                    &request["to"],
                    scope,
                    message_id,
                    answer,
                    Instant::now(),
                )
            })
    }
    /// Records a local `sender`'s message to the remote `id`; whether a new entry was made.
    pub(super) fn record_sent(
        &mut self,
        id: ConnectionId,
        sender: &Value,
        request: &Value,
    ) -> Result<bool, Full> {
        let Some(remote) = self
            .clients
            .get_mut(&id)
            .and_then(|client| client.remote.as_mut())
        else {
            return Err(Full);
        };
        let result = remote.replies.sent(
            sender,
            &request["to"],
            request["scopeId"].as_str().unwrap_or(""),
            request["message"]["id"].as_str().unwrap_or(""),
            Instant::now(),
        );
        if result.is_err() {
            let stable_id = remote.peer.stable_id.clone();
            self.events.emit(
                &format!("reply_table_full:{stable_id}"),
                json!({"event":"reply_table_full","stableId":stable_id,"entries":crate::replies::MAX_ENTRIES}),
            );
        }
        result
    }
    /// Records a forward to a remote destination; `None` after refusing it as overloaded.
    pub(super) fn record_for(
        &mut self,
        origin: ConnectionId,
        destination: ConnectionId,
        sender: &Value,
        request: &Value,
    ) -> Option<bool> {
        if !self.is_remote(destination) {
            return Some(false);
        }
        if let Ok(recorded) = self.record_sent(destination, sender, request) {
            Some(recorded)
        } else {
            self.reject(origin, request, "overloaded", Some("receipts"));
            None
        }
    }
    pub(super) fn unrecord_sent(&mut self, id: ConnectionId, sender: &Value, request: &Value) {
        if let Some(remote) = self
            .clients
            .get_mut(&id)
            .and_then(|client| client.remote.as_mut())
        {
            remote.replies.unsent(
                sender,
                &request["to"],
                request["scopeId"].as_str().unwrap_or(""),
                request["message"]["id"].as_str().unwrap_or(""),
            );
        }
    }
    /// The registered peer of local connection `id`, or null.
    pub(super) fn descriptor_peer(&self, id: ConnectionId) -> Value {
        self.clients
            .get(&id)
            .and_then(|client| client.descriptor.as_ref())
            .map_or(Value::Null, |descriptor| descriptor["peer"].clone())
    }
    /// Takes one result of the link driver: an identified stream becomes the active remote
    /// unless one already is; a refusal only names the peer for link state.
    pub(super) fn link_step(
        &mut self,
        step: Step,
        events: &mpsc::Sender<Event>,
        tasks: &mut JoinSet<ConnectionId>,
    ) -> io::Result<()> {
        match step {
            Step::Idle => {}
            Step::Refused(refusal) => {
                if let (Some(peer), Some(link)) = (&refusal.peer, self.link.as_mut()) {
                    link.identified(&peer.machine_id);
                }
                self.events.emit(
                    &format!("link_refused:{}", refusal.failure.detail()),
                    json!({"event":"link_refused","reason":refusal.failure.detail(),"address":refusal.address,"stableId":refusal.peer.as_ref().map(|peer| &peer.stable_id)}),
                );
            }
            Step::Linked(authenticated) => {
                if self.remote_id().is_some() || tasks.len() > MAX_CONNECTIONS {
                    self.events.emit(
                        "link_refused:busy",
                        json!({"event":"link_refused","reason":"busy","address":authenticated.peer.ip,"stableId":authenticated.peer.stable_id}),
                    );
                    if let Some(link) = self.link.as_mut() {
                        link.handshake_failed();
                    }
                    return Ok(());
                }
                if let Some(link) = self.link.as_mut() {
                    link.identified(&authenticated.peer.machine_id);
                }
                self.activate(*authenticated, events, tasks)?;
                if let Some(link) = self.link.as_mut() {
                    link.connected();
                }
            }
        }
        Ok(())
    }
    pub(super) fn activate(
        &mut self,
        authenticated: Authenticated,
        events: &mpsc::Sender<Event>,
        tasks: &mut JoinSet<ConnectionId>,
    ) -> io::Result<()> {
        let id = ConnectionId(self.next_generation);
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .ok_or_else(|| io::Error::other("connection generation exhausted"))?;
        self.buffers
            .open(id, ConnectionKind::Remote)
            .map_err(io::Error::other)?;
        let (output, receiver) = mpsc::channel(256);
        let accounting = self.buffers.clone();
        let events = events.clone();
        let Authenticated {
            stream,
            peer,
            local,
            remote,
        } = authenticated;
        self.events.emit(
            &format!("link_up:{}", peer.stable_id),
            json!({"event":"link_up","stableId":peer.stable_id,"name":peer.machine_id,"tags":peer.tags,"addresses":peer.addresses,"local":local.to_string(),"remote":remote.to_string(),"caps":peer.caps.digest(),"ignored":peer.ignored.any().then(|| json!({"entries":peer.ignored.entries,"verbs":peer.ignored.verbs,"scopes":peer.ignored.scopes}))}),
        );
        let source = SourceEpoch::new();
        let withdrawal = source.shared_guard();
        let abort = tasks.spawn(async move {
            let _withdrawal = withdrawal;
            transport::connection(id, stream, accounting, events, receiver).await;
            id
        });
        let snapshot_rid = random_id()?;
        // The remote exports only what its own caps for this node allow.
        let scopes = self.config.scope_ids.clone();
        self.clients.insert(
            id,
            Client {
                output,
                abort,
                source,
                descriptor: None,
                watch: None,
                link_events: None,
                remote: Some(Remote {
                    roster: Vec::new(),
                    snapshot_rid: snapshot_rid.clone(),
                    scopes: scopes.clone(),
                    established: false,
                    last_progress: Instant::now(),
                    ping: None,
                    peer,
                    refresh: Refresh::new(Instant::now()),
                    replies: crate::replies::Replies::default(),
                    refs: crate::intern::Refs::default(),
                }),
                closing: false,
                failed: false,
            },
        );
        let request =
            json!({"v":2,"op":"discover","rid":snapshot_rid,"scopeIds":scopes,"watch":true});
        if !self.queue(id, &request, BufferClass::Data, None) {
            self.fail(id);
        }
        Ok(())
    }
    /// Whether sends to `machine` are refused at once because its link is not up.
    pub(super) fn link_down(&self, machine: &str) -> bool {
        self.link
            .as_ref()
            .and_then(crate::link::Driver::machine)
            .is_some_and(|identified| identified == machine)
            && !self.remote_established()
    }
    /// The identified peer of the active link.
    fn linked_machine(&self, id: ConnectionId) -> Option<&str> {
        self.clients
            .get(&id)?
            .remote
            .as_ref()
            .map(|remote| remote.peer.machine_id.as_str())
    }
    /// Whether the active remote link has received the peer's roster snapshot.
    ///
    /// Our checks passing does not mean the peer's did: it may still refuse and close. Only the
    /// peer's snapshot proves it accepted us.
    fn remote_established(&self) -> bool {
        self.remote_id().is_some_and(|id| {
            self.clients
                .get(&id)
                .and_then(|client| client.remote.as_ref())
                .is_some_and(|remote| remote.established)
        })
    }
    fn link_view(&self) -> LinkView {
        match &self.link {
            Some(_) if self.remote_established() => LinkView::Up,
            Some(_) if self.remote_id().is_some() => LinkView::Probing,
            Some(link) if link.breaker().view() == LinkView::Up => LinkView::Probing,
            Some(link) => link.breaker().view(),
            None => LinkView::Down,
        }
    }
    /// The current link state frame for one opted-in local session, if a remote is configured.
    pub(super) fn link_frame(&self, rid: &str) -> Option<Value> {
        let machine = self.link.as_ref()?.machine()?;
        let view = self.link_view();
        let since = self
            .link
            .as_ref()
            .map_or(self.bound_at, |link| link.breaker().since());
        let mut frame = json!({"v":2,"op":"link.state","rid":rid,"machineId":machine,"state":view.as_str(),"since":unix_millis(since)});
        if let Some(next) = self
            .link
            .as_ref()
            .and_then(|link| link.breaker().next_probe())
            .filter(|_| view == LinkView::Down)
        {
            frame["nextProbe"] = Value::from(unix_millis(next));
        }
        Some(frame)
    }
    /// Pushes the link state to opted-in sessions and the operator log, exactly on a change.
    pub(super) fn announce_link(&mut self) {
        let Some(machine) = self
            .link
            .as_ref()
            .and_then(crate::link::Driver::machine)
            .map(str::to_owned)
        else {
            return;
        };
        let view = self.link_view();
        if self.link_view == Some(view) {
            return;
        }
        self.link_view = Some(view);
        if self.link.is_some() {
            self.events.emit(
                &format!("link_state:{}", view.as_str()),
                json!({"event":"link_state","machineId":machine,"state":view.as_str()}),
            );
        }
        let subscribers: Vec<_> = self
            .clients
            .iter()
            .filter(|(_, client)| !client.failed && !client.closing)
            .filter_map(|(id, client)| client.link_events.clone().map(|rid| (*id, rid)))
            .collect();
        for (id, rid) in subscribers {
            if let Some(frame) = self.link_frame(&rid)
                && !self.queue(id, &frame, BufferClass::Control, None)
            {
                self.fail(id);
            }
        }
    }
    pub(super) fn deadline(&self) -> Option<Instant> {
        self.forwards
            .values()
            .map(|forward| forward.deadline)
            .chain(
                self.link
                    .as_ref()
                    .and_then(crate::link::Driver::due)
                    .filter(|_| self.remote_id().is_none()),
            )
            .chain(
                self.clients
                    .values()
                    .filter_map(|client| client.remote.as_ref())
                    .filter(|remote| !remote.refresh.running)
                    .map(|remote| remote.refresh.due),
            )
            .chain(
                self.clients
                    .values()
                    .filter_map(|client| client.remote.as_ref())
                    .map(|remote| {
                        remote.last_progress
                            + if remote.ping.is_some() {
                                CLOSE_AFTER
                            } else {
                                PING_AFTER
                            }
                    }),
            )
            .min()
    }
    /// Starts a whois task for every linked peer whose refresh is due; never waits for it.
    pub(super) fn refresh_due(&mut self, now: Instant) {
        let prepared = self.link.as_ref().map(|link| Arc::clone(link.prepared()));
        let mut due = Vec::new();
        for (id, client) in &mut self.clients {
            let Some(remote) = client.remote.as_mut() else {
                continue;
            };
            if client.failed || remote.refresh.running || remote.refresh.due > now {
                continue;
            }
            if prepared.is_some() {
                remote.refresh.running = true;
                due.push((*id, remote.peer.ip));
            } else {
                remote.refresh.due = now + REFRESH_EVERY;
            }
        }
        let Some(prepared) = prepared else {
            return;
        };
        for (id, ip) in due {
            let prepared = Arc::clone(&prepared);
            self.refreshes
                .spawn(async move { (id, prepared.identify(ip).await) });
        }
    }
    /// Applies one refresh: a vanished, expired, renamed or re-keyed node, empty caps or two
    /// failures in a row close the link; changed caps apply to the next frame, and losing
    /// `discover` on a watched scope ends the remote's watch.
    pub(super) fn refreshed(&mut self, id: ConnectionId, result: Result<Peer, Failure>) {
        let Some(remote) = self
            .clients
            .get_mut(&id)
            .filter(|client| !client.failed)
            .and_then(|client| client.remote.as_mut())
        else {
            return;
        };
        remote.refresh.running = false;
        remote.refresh.due = Instant::now() + REFRESH_EVERY;
        let stable_id = remote.peer.stable_id.clone();
        let verdict = match result {
            Ok(peer) if peer.stable_id != stable_id => Err("stable-id-changed"),
            Ok(peer) if peer.machine_id != remote.peer.machine_id => Err("name-changed"),
            Ok(peer) if peer.caps.is_empty() => Err("no-caps"),
            Ok(peer) => Ok(peer),
            Err(failure @ (Failure::NotFound | Failure::Refused(_))) => Err(failure.detail()),
            Err(failure) => {
                remote.refresh.failures = remote.refresh.failures.saturating_add(1);
                let failures = remote.refresh.failures;
                self.events.emit(
                    &format!("whois_failed:{}", failure.detail()),
                    json!({"event":"whois_failed","stableId":stable_id,"reason":failure.detail(),"failures":failures}),
                );
                if failures >= REFRESH_FAILURES {
                    self.revoke(id, &stable_id, "refresh-failed");
                }
                return;
            }
        };
        let peer = match verdict {
            Ok(peer) => peer,
            Err(reason) => {
                self.revoke(id, &stable_id, reason);
                return;
            }
        };
        remote.refresh.failures = 0;
        let (before, after) = (remote.peer.caps.digest(), peer.caps.digest());
        let discover = peer.caps.scopes(Verb::Discover);
        remote.peer = peer;
        if before == after {
            return;
        }
        self.events.emit(
            &format!("caps_changed:{stable_id}"),
            json!({"event":"caps_changed","stableId":stable_id,"before":before,"after":after}),
        );
        let lost = self
            .clients
            .get(&id)
            .and_then(|client| client.watch.as_ref())
            .filter(|watch| watch.scopes.iter().any(|scope| !discover.contains(scope)))
            .map(|watch| watch.rid.clone());
        if let Some(rid) = lost {
            if let Some(client) = self.clients.get_mut(&id) {
                client.watch = None;
            }
            let invalidated = json!({"v":2,"op":"roster.event","rid":rid,"event":{"tag":"invalidated","reason":"policy_changed"}});
            if !self.queue(id, &invalidated, BufferClass::Control, None) {
                self.fail(id);
            }
        }
    }
    fn revoke(&mut self, id: ConnectionId, stable_id: &str, reason: &str) {
        self.events.emit(
            &format!("link_revoked:{reason}"),
            json!({"event":"link_revoked","stableId":stable_id,"reason":reason}),
        );
        self.fail(id);
    }
    pub(super) fn liveness(&mut self) {
        let Some(id) = self.remote_id() else {
            return;
        };
        let Some(remote) = self
            .clients
            .get(&id)
            .and_then(|client| client.remote.as_ref())
        else {
            return;
        };
        let idle = remote.last_progress.elapsed();
        if idle >= CLOSE_AFTER {
            self.fail(id);
            return;
        }
        if idle >= PING_AFTER && remote.ping.is_none() {
            let Ok(rid) = random_id() else {
                self.fail(id);
                return;
            };
            if !self.queue(
                id,
                &json!({"v":2,"op":"ping","rid":rid}),
                BufferClass::Control,
                None,
            ) {
                self.fail(id);
                return;
            }
            if let Some(remote) = self
                .clients
                .get_mut(&id)
                .and_then(|client| client.remote.as_mut())
            {
                remote.ping = Some(rid);
            }
        }
    }
    pub(super) fn remote_frame(&mut self, id: ConnectionId, request: Value) {
        if self.clients.get(&id).is_none_or(|client| {
            !client.source.active()
                || client
                    .remote
                    .as_ref()
                    .is_none_or(|remote| remote.last_progress.elapsed() >= CLOSE_AFTER)
        }) {
            self.fail(id);
            return;
        }
        // Only complete authenticated structurally valid inbound frames count as progress.
        if let Some(remote) = self
            .clients
            .get_mut(&id)
            .and_then(|client| client.remote.as_mut())
        {
            remote.last_progress = Instant::now();
            remote.ping = None;
        }
        match request["op"].as_str() {
            Some("result") => {
                let snapshot = self
                    .clients
                    .get(&id)
                    .and_then(|client| client.remote.as_ref())
                    .is_some_and(|remote| request["rid"] == remote.snapshot_rid);
                if snapshot {
                    if self
                        .clients
                        .get(&id)
                        .and_then(|client| client.remote.as_ref())
                        .is_some_and(|remote| !remote.established)
                    {
                        self.roster_snapshot(id, &request);
                    }
                } else {
                    self.reply(id, request);
                }
            }
            Some("roster.event") => self.roster_event(id, &request),
            Some("ping") => self.respond(id, &request, json!({"tag":"ok","value":{}})),
            Some("discover") => self.export(id, &request),
            Some("unwatch") => {
                if let Some(client) = self.clients.get_mut(&id)
                    && client
                        .watch
                        .as_ref()
                        .is_some_and(|watch| request["watchRid"] == watch.rid)
                {
                    client.watch = None;
                }
                self.respond(id, &request, json!({"tag":"ok","value":{}}));
            }
            Some("state.get" | "state.list" | "interest.add" | "interest.remove") => {
                self.reject(id, &request, "forbidden", None);
            }
            Some("send") => {
                let mut request = request;
                if self
                    .clients
                    .get(&id)
                    .and_then(|client| client.remote.as_ref())
                    .is_none_or(|remote| remote.refs.expand(&mut request).is_err())
                {
                    self.fail(id);
                    return;
                }
                let valid_source =
                    self.remote_descriptor(id, &request["from"])
                        .is_some_and(|descriptor| {
                            member(descriptor, request["scopeId"].as_str().unwrap_or(""))
                        });
                let duplicate = self.forwards.values().any(|forward| {
                    forward.origin == id && forward.request["rid"] == request["rid"]
                }) || self
                    .clients
                    .get(&id)
                    .and_then(|client| client.watch.as_ref())
                    .is_some_and(|watch| request["rid"] == watch.rid);
                if !valid_source || duplicate {
                    self.fail(id);
                } else {
                    self.forward(id, request);
                }
            }
            _ => self.fail(id),
        }
    }
    pub(super) fn export(&mut self, id: ConnectionId, request: &Value) {
        if self
            .clients
            .get(&id)
            .and_then(|client| client.watch.as_ref())
            .is_some()
            && request["watch"] == true
        {
            self.reject(id, request, "overloaded", Some("watch"));
            return;
        }
        let allowed = self
            .clients
            .get(&id)
            .and_then(|client| client.remote.as_ref())
            .map(|remote| remote.peer.caps.scopes(Verb::Discover))
            .unwrap_or_default();
        let scopes: Vec<String> = request["scopeIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|scope| allowed.iter().any(|allowed| allowed == scope))
            .map(str::to_owned)
            .collect();
        let mut peers: Vec<_> = self
            .clients
            .values()
            .filter(|client| !client.failed && !client.closing)
            .filter_map(|client| client.descriptor.as_ref())
            .filter_map(|descriptor| project(descriptor, &scopes))
            .collect();
        peers.sort_by_key(|descriptor| descriptor["peer"].to_string());
        let watching = request["watch"] == true;
        let response = json!({"v":2,"op":"result","rid":request["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":peers,"watching":watching}}});
        if !self.queue(id, &response, BufferClass::Data, None) {
            self.fail(id);
            return;
        }
        if watching {
            if let Some(remote) = self
                .clients
                .get_mut(&id)
                .and_then(|client| client.remote.as_mut())
            {
                for descriptor in &peers {
                    remote.refs.exported(&descriptor["peer"]);
                }
            }
            let generation = self.next_watch_generation;
            let Some(next) = generation.checked_add(1) else {
                self.fail(id);
                return;
            };
            self.next_watch_generation = next;
            if let Some(client) = self.clients.get_mut(&id) {
                client.watch = Some(Watch {
                    rid: request["rid"].as_str().unwrap_or("").to_owned(),
                    generation,
                    scopes,
                    events: 0,
                    bytes: 0,
                });
            }
        }
    }
    fn valid_descriptor(&self, id: ConnectionId, descriptor: &Value) -> bool {
        self.linked_machine(id)
            .is_some_and(|machine| descriptor["peer"]["machineId"] == machine)
            && self
                .clients
                .get(&id)
                .and_then(|client| client.remote.as_ref())
                .is_some_and(|remote| {
                    descriptor["scopeIds"].as_array().is_some_and(|scopes| {
                        scopes.iter().all(|scope| {
                            scope.as_str().is_some_and(|scope| {
                                remote.scopes.iter().any(|allowed| allowed == scope)
                            })
                        })
                    })
                })
            && encoded_length(descriptor).is_some_and(|length| length <= 512)
    }
    fn roster_entry(
        &self,
        id: ConnectionId,
        descriptor: &Value,
    ) -> Option<(Value, Charge, SourceEpoch)> {
        if !self.valid_descriptor(id, descriptor) {
            return None;
        }
        let charge = self
            .buffers
            .reserve(id, BufferClass::Data, encoded_length(descriptor)?)
            .ok()?;
        Some((descriptor.clone(), charge, SourceEpoch::new()))
    }
    fn roster_snapshot(&mut self, id: ConnectionId, response: &Value) {
        if response["forOp"] != "discover"
            || response["outcome"]["tag"] != "ok"
            || response["outcome"]["value"]["watching"] != true
            || self
                .clients
                .get(&id)
                .and_then(|client| client.remote.as_ref())
                .is_none_or(|remote| remote.established)
        {
            self.fail(id);
            return;
        }
        let Some(peers) = response["outcome"]["value"]["peers"]
            .as_array()
            .filter(|peers| peers.len() <= 30)
        else {
            self.fail(id);
            return;
        };
        let mut roster = Vec::with_capacity(peers.len());
        for descriptor in peers {
            if roster
                .iter()
                .any(|(prior, _, _): &(Value, Charge, SourceEpoch)| {
                    prior["peer"] == descriptor["peer"]
                })
            {
                self.fail(id);
                return;
            }
            let Some(entry) = self.roster_entry(id, descriptor) else {
                self.fail(id);
                return;
            };
            roster.push(entry);
        }
        if let Some(remote) = self
            .clients
            .get_mut(&id)
            .and_then(|client| client.remote.as_mut())
        {
            for (descriptor, _, _) in &roster {
                remote.refs.imported(&descriptor["peer"]);
            }
            remote.roster = roster;
            remote.established = true;
        }
        for descriptor in peers {
            self.publish(descriptor, "upsert");
        }
    }
    fn roster_event(&mut self, id: ConnectionId, request: &Value) {
        let Some(remote) = self
            .clients
            .get(&id)
            .and_then(|client| client.remote.as_ref())
        else {
            return;
        };
        if request["rid"] != remote.snapshot_rid {
            return;
        }
        if !remote.established {
            self.fail(id);
            return;
        }
        let event = &request["event"];
        if event["tag"] == "invalidated" {
            self.fail(id);
            return;
        }
        let upsert = event["tag"] == "upsert";
        let peer = if upsert {
            &event["peer"]["peer"]
        } else {
            &event["peer"]
        };
        if !self
            .linked_machine(id)
            .is_some_and(|machine| peer["machineId"] == machine)
        {
            self.fail(id);
            return;
        }
        let entry = if upsert {
            let Some(entry) = self.roster_entry(id, &event["peer"]) else {
                self.fail(id);
                return;
            };
            Some(entry)
        } else {
            None
        };
        let old = self
            .clients
            .get_mut(&id)
            .and_then(|client| client.remote.as_mut())
            .and_then(|remote| {
                remote
                    .roster
                    .iter()
                    .position(|(descriptor, _, _)| descriptor["peer"] == *peer)
                    .map(|index| remote.roster.remove(index))
            });
        if let Some((descriptor, charge, epoch)) = old {
            epoch.withdraw();
            self.publish(&descriptor, "remove");
            drop(charge);
        }
        if let Some(entry) = entry {
            let full = self
                .clients
                .get(&id)
                .and_then(|client| client.remote.as_ref())
                .is_none_or(|remote| remote.roster.len() >= 30);
            if full {
                self.fail(id);
                return;
            }
            self.publish(&entry.0, "upsert");
            if let Some(remote) = self
                .clients
                .get_mut(&id)
                .and_then(|client| client.remote.as_mut())
            {
                remote.refs.imported(&entry.0["peer"]);
                remote.roster.push(entry);
            }
        }
    }
}

fn unix_millis(at: Instant) -> u64 {
    let now = Instant::now();
    let wall = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let wall = if at <= now {
        wall.saturating_sub(now - at)
    } else {
        wall + (at - now)
    };
    u64::try_from(wall.as_millis()).unwrap_or(u64::MAX)
}
