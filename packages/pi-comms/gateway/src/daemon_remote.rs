//! Authenticated own-machine roster exchange and directional two-host routing.
use std::io;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tokio::time::Instant;

use super::{Client, Daemon, Remote, Watch, encoded_length, member, project, random_id};
use crate::budget::{BufferClass, ConnectionId, ConnectionKind};
use crate::config::Permission;
use crate::remote::Authenticated;
use crate::transport::{self, Charge, Event, SourceEpoch};

const PING_AFTER: Duration = Duration::from_secs(30);
const CLOSE_AFTER: Duration = Duration::from_secs(90);

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
                client
                    .remote
                    .as_ref()
                    .is_some_and(|remote| remote.expires > Instant::now())
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
                    machine == self.config.machine_id && self.config.remote_scopes().contains(scope)
                } else {
                    self.config.permits(machine, scope, Permission::Discover)
                }
            })
            .cloned()
            .collect();
        project(descriptor, &scopes)
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
        let (stream, lease) = authenticated.into_parts();
        let source = SourceEpoch::new();
        let withdrawal = source.shared_guard();
        let expires = lease.deadline();
        let abort = tasks.spawn(async move {
            let _withdrawal = withdrawal;
            lease
                .guard(
                    transport::connection(id, stream, accounting, events, receiver),
                    std::future::pending(),
                )
                .await;
            id
        });
        let snapshot_rid = random_id()?;
        let scopes = self.config.remote_scopes();
        self.clients.insert(
            id,
            Client {
                output,
                abort,
                source,
                descriptor: None,
                watch: None,
                remote: Some(Remote {
                    roster: Vec::new(),
                    snapshot_rid: snapshot_rid.clone(),
                    scopes: scopes.clone(),
                    established: false,
                    expires,
                    last_progress: Instant::now(),
                    ping: None,
                }),
                closing: false,
                failed: false,
            },
        );
        let request =
            json!({"v":1,"op":"discover","rid":snapshot_rid,"scopeIds":scopes,"watch":true});
        if !self.queue(id, &request, BufferClass::Data, None) {
            self.fail(id);
        }
        Ok(())
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
                    .flat_map(|remote| {
                        [
                            remote.expires,
                            remote.last_progress
                                + if remote.ping.is_some() {
                                    CLOSE_AFTER
                                } else {
                                    PING_AFTER
                                },
                        ]
                    }),
            )
            .min()
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
                &json!({"v":1,"op":"ping","rid":rid}),
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
                || client.remote.as_ref().is_none_or(|remote| {
                    remote.expires <= Instant::now()
                        || remote.last_progress.elapsed() >= CLOSE_AFTER
                })
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
            Some("send" | "state.get" | "state.list" | "interest.add" | "interest.remove") => {
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
    fn export(&mut self, id: ConnectionId, request: &Value) {
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
        let allowed = self.config.remote_scopes();
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
        let response = json!({"v":1,"op":"result","rid":request["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":peers,"watching":watching}}});
        if !self.queue(id, &response, BufferClass::Data, None) {
            self.fail(id);
            return;
        }
        if watching {
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
        self.config
            .remote
            .as_ref()
            .is_some_and(|remote| descriptor["peer"]["machineId"] == remote.machine_id())
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
            .config
            .remote
            .as_ref()
            .is_some_and(|remote| peer["machineId"] == remote.machine_id())
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
                remote.roster.push(entry);
            }
        }
    }
}
