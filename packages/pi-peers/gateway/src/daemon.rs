//! Foreground single-worker Unix daemon with bounded routes, forwarding and output queues.
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::{AbortHandle, JoinSet};
use tokio::time::Instant;

use serde_json::{Value, json};
use tokio::net::{UnixListener, UnixStream};

use crate::breaker::LinkView;
use crate::budget::{BufferClass, ConnectionId, ConnectionKind};
use crate::caps::Verb;
use crate::config::{Config, Permission};
use crate::events::Events;
use crate::link::{Driver, Step};

#[path = "daemon_remote.rs"]
mod remote_routing;
use crate::transport::{self, Accounting, Charge, Event, ForwardPermit, Output, SourceEpoch};
use crate::wire::{self, Role};

const OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CONNECTIONS: usize = 30;
const MAX_OPERATIONS: usize = 256;
const MAX_LOCAL_OPERATIONS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Lifetime {
    Manual,
    Managed,
}

#[derive(Debug)]
struct Watch {
    rid: String,
    generation: u64,
    scopes: Vec<String>,
    events: usize,
    bytes: usize,
}
#[derive(Debug)]
struct Client {
    output: mpsc::Sender<Output>,
    abort: AbortHandle,
    source: SourceEpoch,
    descriptor: Option<Value>,
    watch: Option<Watch>,
    remote: Option<Remote>,
    link_events: Option<String>,
    closing: bool,
    failed: bool,
}
#[derive(Debug)]
struct Remote {
    roster: Vec<(Value, Charge, SourceEpoch)>,
    snapshot_rid: String,
    established: bool,
    last_progress: Instant,
    ping: Option<String>,
    scopes: Vec<String>,
    /// Who tailscaled says the peer is and what it may do here; its `StableID` is pinned.
    peer: crate::tailscale::Peer,
    /// Interning tables of this link generation; a new link starts empty.
    refs: crate::intern::Refs,
}
#[derive(Debug)]
struct Forward {
    origin: ConnectionId,
    destination: ConnectionId,
    /// The original request, retained for exact result binding and correlation checks.
    request: Value,
    deadline: Instant,
    reservation: Charge,
}

/// Explicitly bound volatile daemon; dropping it only removes its own socket inode.
#[derive(Debug)]
pub struct Daemon {
    config: Config,
    remote_degraded: Option<&'static str>,
    managed: bool,
    restart: Option<(ConnectionId, Instant)>,
    listener: UnixListener,
    socket_inode: u64,
    socket_device: u64,
    clients: HashMap<ConnectionId, Client>,
    buffers: Accounting,
    forwards: HashMap<String, Forward>,
    link: Option<Driver>,
    link_view: Option<LinkView>,
    bound_at: Instant,
    events: Events,
    next_generation: u64,
    next_watch_generation: u64,
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "private owner-only socket directory required",
    )
}

impl Daemon {
    /// Binds a new socket only within an existing private directory owned by this user.
    ///
    /// Never unlinks an existing path, creates directories or starts another process.
    ///
    /// # Errors
    /// Rejects unsafe directory ancestry, existing socket paths, overlong paths and bind errors.
    pub fn bind(config: Config) -> io::Result<Self> {
        crate::paths::private_parent(&config.socket_path)?;
        let (link, remote_degraded) = match config
            .remote
            .as_ref()
            .map(|settings| settings.prepare(&config.machine_id))
        {
            None => (None, None),
            Some(Err(failure)) => (None, Some(failure.reason())),
            Some(Ok(prepared)) => match Driver::new(prepared) {
                Ok(link) => (Some(link), None),
                Err(error) => match crate::remote::degradation(&error) {
                    Some(reason) => (None, Some(reason)),
                    None => return Err(error),
                },
            },
        };
        let parent = config.socket_path.parent().ok_or_else(denied)?;
        // peer credentials are not process attestation; the socket directory is the boundary.
        let owner = current_uid();
        let metadata = std::fs::symlink_metadata(parent)?;
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.uid() != owner
            || metadata.mode() & 0o077 != 0
        {
            return Err(denied());
        }
        reject_symlink_ancestors(parent)?;
        if config.socket_path.as_os_str().len() > 100 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "socket path too long",
            ));
        }
        let listener = UnixListener::bind(&config.socket_path)?;
        std::fs::set_permissions(&config.socket_path, std::fs::Permissions::from_mode(0o600))?;
        let socket = std::fs::symlink_metadata(&config.socket_path)?;
        Ok(Self {
            config,
            remote_degraded,
            managed: false,
            restart: None,
            link,
            link_view: None,
            bound_at: Instant::now(),
            events: Events::default(),
            listener,
            socket_inode: socket.ino(),
            socket_device: socket.dev(),
            clients: HashMap::new(),
            buffers: Accounting::default(),
            forwards: HashMap::new(),
            next_generation: 1,
            next_watch_generation: 1,
        })
    }

    /// Returns the explicitly configured Unix socket path for readiness reporting.
    pub fn socket_path(&self) -> &Path {
        &self.config.socket_path
    }
    /// Returns a sanitized startup credential degradation reason, not live link status.
    pub fn remote_degraded_reason(&self) -> Option<&'static str> {
        self.remote_degraded
    }

    /// Returns the remote listener's actually bound address, resolving a configured port 0.
    ///
    /// `None` when no remote is configured or the remote endpoint connects out.
    pub fn remote_listen_address(&self) -> Option<std::net::SocketAddr> {
        self.link.as_ref().and_then(Driver::local_address)
    }
    /// Returns the configured authoritative local machine identity.
    pub fn machine_id(&self) -> &str {
        &self.config.machine_id
    }

    /// Runs one routing owner, at most 30 local tasks and one leased remote stream.
    ///
    /// Queues use nonblocking bounded offers. Idle streams have no periodic timer;
    /// only actual assembly/write/forward deadlines schedule time wakeups.
    ///
    /// # Errors
    /// Returns fatal listener errors; connection errors retire only affected routes.
    pub async fn run(self, shutdown: impl Future<Output = ()>) -> io::Result<()> {
        self.run_lifetime(shutdown, Lifetime::Manual).await
    }

    /// Runs until shutdown or bounded absence of registered local participants.
    ///
    /// Startup allows ten seconds for first registration; after participation,
    /// an empty local roster allows 750ms for reload/reconnect handoff. Remote
    /// links and unregistered sockets never extend either interval.
    ///
    /// # Errors
    /// Returns fatal listener or connection-task errors, as with [`Self::run`].
    pub async fn run_managed(self, shutdown: impl Future<Output = ()>) -> io::Result<()> {
        self.run_lifetime(shutdown, Lifetime::Managed).await
    }

    async fn run_lifetime(
        mut self,
        shutdown: impl Future<Output = ()>,
        lifetime: Lifetime,
    ) -> io::Result<()> {
        let managed = lifetime == Lifetime::Managed;
        self.managed = managed;
        tokio::pin!(shutdown);
        let mut idle = managed.then(|| Instant::now() + crate::managed::STARTUP_GRACE);
        let mut participated = false;
        let (events, mut receive) = mpsc::channel(68);
        let mut tasks = JoinSet::new();
        loop {
            self.cleanup();
            let participants = self.clients.values().any(|client| {
                client.remote.is_none()
                    && client.descriptor.is_some()
                    && !client.closing
                    && !client.failed
            });
            if managed && participants {
                participated = true;
                idle = None;
            } else if managed && participated && idle.is_none() {
                idle = Some(Instant::now() + crate::managed::DISCONNECT_GRACE);
            }
            let active = self.remote_id().is_some();
            if !active && let Some(link) = self.link.as_mut() {
                link.start();
            }
            self.announce_link();
            let deadline = self.deadline();
            tokio::select! {
                () = &mut shutdown => return Ok(()),
                () = transport::next_deadline(idle) => return Ok(()),
                () = transport::next_deadline(self.restart.map(|(_, deadline)| deadline)) => return Ok(()),
                accepted = self.listener.accept() => {
                    let (stream, _) = accepted?;
                    if tasks.len() < MAX_CONNECTIONS + usize::from(self.remote_id().is_some()) && self.clients.values().filter(|client| client.remote.is_none()).count() < MAX_CONNECTIONS { self.accept(stream, &events, &mut tasks)?; }
                }
                step = remote_progress(self.link.as_mut()) => self.link_step(step?, &events, &mut tasks)?,
                Some(event) = receive.recv() => self.event(event),
                Some(joined) = tasks.join_next(), if !tasks.is_empty() => {
                    match joined {
                        Ok(id) => {
                            if self.restart.is_some_and(|(requester, _)| requester == id) { return Ok(()); }
                            self.disconnect(id);
                        },
                        Err(error) if error.is_cancelled() => {},
                        Err(_) => return Err(io::Error::other("connection task failed")),
                    }
                }
                () = transport::next_deadline(deadline) => {
                    self.liveness();
                    let now = Instant::now();
                    let expired: Vec<_> = self.forwards.iter().filter(|(_, forward)| forward.deadline <= now).map(|(rid, _)| rid.clone()).collect();
                    for rid in expired {
                        let remote = self.forwards.get(&rid).is_some_and(|forward| self.is_remote(forward.destination));
                        self.events.emit("forward_timeout", json!({"event":"forward_timeout","remote":remote}));
                        self.retire(&rid, "unavailable");
                    }
                }
            }
        }
    }

    fn accept(
        &mut self,
        stream: UnixStream,
        events: &mpsc::Sender<Event>,
        tasks: &mut JoinSet<ConnectionId>,
    ) -> io::Result<()> {
        // A peer may disconnect before accept/credential inspection. Reject that
        // connection only; it must not terminate the listener or managed grace.
        if !stream
            .peer_cred()
            .is_ok_and(|credentials| credentials.uid() == current_uid())
        {
            return Ok(());
        }
        let id = ConnectionId(self.next_generation);
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .ok_or_else(|| io::Error::other("connection generation exhausted"))?;
        self.buffers
            .open(id, ConnectionKind::Local)
            .map_err(|_| io::Error::other("connection accounting failed"))?;
        let (output, receiver) = mpsc::channel(256);
        let accounting = self.buffers.clone();
        let events = events.clone();
        let abort = tasks.spawn(async move {
            transport::connection(id, stream, accounting, events, receiver).await;
            id
        });
        self.clients.insert(
            id,
            Client {
                output,
                abort,
                source: SourceEpoch::new(),
                descriptor: None,
                remote: None,
                watch: None,
                link_events: None,
                closing: false,
                failed: false,
            },
        );
        Ok(())
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Frame { id, bytes, charge } => {
                if self
                    .clients
                    .get(&id)
                    .is_some_and(|client| !client.failed && !client.closing)
                {
                    if let Ok(parser) = self.buffers.reserve(id, BufferClass::Data, bytes.len() * 2)
                    {
                        let remote = self
                            .clients
                            .get(&id)
                            .is_some_and(|client| client.remote.is_some());
                        match wire::decode_body(
                            &bytes,
                            if remote {
                                Role::RemoteLink
                            } else {
                                Role::LocalClient
                            },
                        ) {
                            Ok(value) if remote => self.remote_frame(id, value),
                            Ok(value) => self.handle(id, value),
                            Err(_) => self.fail(id),
                        }
                        drop(parser);
                    } else {
                        self.fail(id);
                    }
                }
                drop(bytes);
                drop(charge);
            }
            Event::Written { id, watch, bytes } => {
                if let Some(active) = self
                    .clients
                    .get_mut(&id)
                    .and_then(|client| client.watch.as_mut())
                    .filter(|active| active.generation == watch)
                {
                    active.events = active.events.saturating_sub(1);
                    active.bytes = active.bytes.saturating_sub(bytes);
                }
            }
        }
    }

    fn cleanup(&mut self) {
        let failed: Vec<_> = self
            .clients
            .iter()
            .filter(|(_, client)| {
                client.failed || (client.remote.is_some() && !client.source.active())
            })
            .map(|(id, _)| *id)
            .collect();
        for id in failed {
            self.disconnect(id);
        }
    }

    fn fail(&mut self, id: ConnectionId) {
        if let Some(client) = self.clients.get_mut(&id) {
            client.failed = true;
        }
    }

    fn queue(
        &mut self,
        id: ConnectionId,
        value: &Value,
        class: BufferClass,
        watch_generation: Option<u64>,
    ) -> bool {
        self.queue_authorized(id, value, class, watch_generation, None)
    }

    fn queue_authorized(
        &mut self,
        id: ConnectionId,
        value: &Value,
        class: BufferClass,
        watch_generation: Option<u64>,
        source: Option<ForwardPermit>,
    ) -> bool {
        let Some(length) = encoded_length(value).filter(|length| *length <= wire::MAX_BODY) else {
            return false;
        };
        let Ok(charge) = self.buffers.reserve(id, class, length + 4) else {
            return false;
        };
        let mut bytes = Vec::with_capacity(length + 4);
        let Ok(length_prefix) = u32::try_from(length) else {
            drop(charge);
            return false;
        };
        bytes.extend_from_slice(&length_prefix.to_be_bytes());
        if serde_json::to_writer(&mut bytes, value).is_err() {
            drop(charge);
            return false;
        }
        let Some(client) = self.clients.get(&id) else {
            return false;
        };
        if client.failed {
            return false;
        }
        client
            .output
            .try_send(Output {
                bytes,
                enqueued: Instant::now(),
                reservation: charge,
                watch: watch_generation,
                source,
                finish: value["op"] == "result"
                    && matches!(value["forOp"].as_str(), Some("close" | "gateway.restart"))
                    && value["outcome"]["tag"] == "ok",
            })
            .is_ok()
    }

    fn respond(&mut self, id: ConnectionId, request: &Value, outcome: Value) {
        // Echo the request's version: only a v1 `gateway.restart` can differ from v2.
        let version = if request["op"] == "gateway.restart" && request["v"] == 1 {
            1
        } else {
            wire::WIRE_VERSION
        };
        let mut response =
            json!({"v":version,"op":"result","rid":request["rid"],"forOp":request["op"]});
        response["outcome"] = outcome;
        if !self.queue(id, &response, BufferClass::Control, None) {
            self.fail(id);
        }
    }

    fn reject(&mut self, id: ConnectionId, request: &Value, code: &str, resource: Option<&str>) {
        if code == "overloaded"
            && let Some(resource) = resource
        {
            self.events.emit(
                &format!("overloaded:{resource}"),
                json!({"event":"overloaded","resource":resource,"op":request["op"]}),
            );
        }
        let mut outcome = if request["op"] == "send" {
            let sender = if self.is_remote(id) {
                request.get("from")
            } else {
                self.descriptor(id).map(|descriptor| &descriptor["peer"])
            };
            if sender.is_none() {
                self.fail(id);
                return;
            }
            json!({"tag":"not_admitted","messageId":request["message"]["id"],"code":code})
        } else {
            json!({"tag":"error","code":code})
        };
        if let Some(resource) = resource {
            outcome["resource"] = Value::from(resource);
        }
        self.respond(id, request, outcome);
    }

    fn handle(&mut self, id: ConnectionId, request: Value) {
        if request["op"] == "result" {
            self.reply(id, request);
            return;
        }
        if request["op"] == "roster.event" {
            self.fail(id);
            return;
        }
        let registered = self
            .clients
            .get(&id)
            .is_some_and(|client| client.descriptor.is_some());
        if request["op"] == "gateway.restart" {
            if !self.managed
                || request["expectedMachineId"] != self.config.machine_id
                || self.restart.is_some()
            {
                self.fail(id);
            } else {
                self.restart = Some((id, Instant::now() + std::time::Duration::from_secs(2)));
                self.respond(id, &request, json!({"tag":"ok","value":{}}));
                if let Some(client) = self.clients.get_mut(&id) {
                    client.closing = true;
                }
            }
            return;
        }
        if request["op"] == "register" {
            self.register(id, &request);
            return;
        }
        if !registered {
            self.fail(id);
            return;
        }
        if self
            .forwards
            .values()
            .any(|forward| forward.origin == id && forward.request["rid"] == request["rid"])
            || self
                .clients
                .get(&id)
                .and_then(|client| client.watch.as_ref())
                .is_some_and(|watch| watch.rid == request["rid"].as_str().unwrap_or(""))
        {
            self.fail(id);
            return;
        }
        match request["op"].as_str() {
            Some("close") => {
                self.withdraw(id);
                self.respond(id, &request, json!({"tag":"ok","value":{}}));
                if let Some(client) = self.clients.get_mut(&id) {
                    client.closing = true;
                }
            }
            Some("discover") => self.discover(id, &request),
            Some("unwatch") => {
                if let Some(client) = self.clients.get_mut(&id)
                    && client.watch.as_ref().is_some_and(|watch| {
                        watch.rid == request["watchRid"].as_str().unwrap_or("")
                    })
                {
                    client.watch = None;
                }
                self.respond(id, &request, json!({"tag":"ok","value":{}}));
            }
            Some("send") => self.forward(id, request),
            Some("state.get" | "state.list" | "interest.add" | "interest.remove") => {
                self.reject(id, &request, "forbidden", None);
            }
            _ => self.fail(id),
        }
    }

    fn register(&mut self, id: ConnectionId, request: &Value) {
        if let Some(expected) = request.get("expectedConfigSha256")
            && (!self.managed || self.config.loaded_config_sha256.as_deref() != expected.as_str())
        {
            self.reject(id, request, "config_mismatch", None);
            return;
        }
        if self
            .clients
            .get(&id)
            .is_some_and(|client| client.descriptor.is_some())
        {
            self.reject(id, request, "already_registered", None);
            return;
        }
        let peer = json!({"machineId":self.config.machine_id,"sessionId":request["sessionId"],"runtimeNonce":request["runtimeNonce"]});
        if self.clients.values().any(|client| {
            client
                .descriptor
                .as_ref()
                .is_some_and(|descriptor| descriptor["peer"] == peer)
        }) {
            self.reject(id, request, "already_registered", None);
            return;
        }
        if self
            .clients
            .values()
            .filter(|client| client.descriptor.is_some())
            .count()
            >= 30
        {
            self.reject(id, request, "overloaded", Some("registrations"));
            return;
        }
        let scopes: Vec<_> = request["scopeIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|scope| {
                scope.as_str().is_some_and(|scope| {
                    self.config
                        .scope_ids
                        .iter()
                        .any(|approved| approved == scope)
                })
            })
            .cloned()
            .collect();
        if scopes.is_empty() {
            self.reject(id, request, "forbidden", None);
            return;
        }
        let descriptor = json!({"peer":peer,"label":request["label"],"scopeIds":scopes});
        if encoded_length(&descriptor).is_none_or(|length| length > 512) {
            self.reject(id, request, "descriptor_too_large", None);
            return;
        }
        let link_events = Some(request["rid"].as_str().unwrap_or("").to_owned());
        if let Some(client) = self.clients.get_mut(&id) {
            client.descriptor = Some(descriptor.clone());
            client.link_events.clone_from(&link_events);
        }
        self.respond(
            id,
            request,
            json!({"tag":"ok","value":{"peer":peer,"scopeIds":scopes}}),
        );
        if let Some(rid) = link_events
            && let Some(frame) = self.link_frame(&rid)
            && !self.queue(id, &frame, BufferClass::Control, None)
        {
            self.fail(id);
        }
        self.publish(&descriptor, "upsert");
        if let Some(link) = self.link.as_mut() {
            link.local_reconnection();
        }
    }

    fn descriptor(&self, id: ConnectionId) -> Option<&Value> {
        self.clients.get(&id)?.descriptor.as_ref()
    }
    fn eligible(&self, id: ConnectionId, descriptor: &Value, scope: &str) -> bool {
        self.descriptor(id).is_some_and(|own| member(own, scope))
            && member(descriptor, scope)
            && descriptor["peer"]["machineId"]
                .as_str()
                .is_some_and(|machine| self.config.permits(machine, scope, Permission::Push))
    }

    fn discover(&mut self, id: ConnectionId, request: &Value) {
        let scopes: Vec<String> = request["scopeIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        // A linked remote's export is already filtered by the caps it grants this node, so local
        // sessions see remote entries without a local grant; local entries still need one.
        if !scopes.iter().all(|scope| {
            self.descriptor(id).is_some_and(|own| member(own, scope))
                && (self.link.is_some()
                    || self
                        .config
                        .permits(&self.config.machine_id, scope, Permission::Discover))
        }) {
            self.reject(id, request, "forbidden", None);
            return;
        }
        let watching = request["watch"] == true;
        if watching
            && self
                .clients
                .get(&id)
                .is_some_and(|client| client.watch.is_some())
        {
            self.reject(id, request, "overloaded", Some("watch"));
            return;
        }
        let generation = self.next_watch_generation;
        if watching {
            let Some(next) = generation.checked_add(1) else {
                self.fail(id);
                return;
            };
            self.next_watch_generation = next;
        }
        let mut peers: Vec<_> = self
            .all_descriptors()
            .into_iter()
            .filter_map(|descriptor| self.discovery_projection(id, descriptor, &scopes))
            .collect();
        peers.sort_by_key(|descriptor| descriptor["peer"].to_string());
        let result = json!({"v":2,"op":"result","rid":request["rid"],"forOp":"discover","outcome":{"tag":"ok","value":{"peers":peers,"watching":watching}}});
        if !self.queue(id, &result, BufferClass::Data, None) {
            self.fail(id);
            return;
        }
        if watching && let Some(client) = self.clients.get_mut(&id) {
            client.watch = Some(Watch {
                rid: request["rid"].as_str().unwrap_or("").to_owned(),
                generation,
                scopes,
                events: 0,
                bytes: 0,
            });
        }
    }

    fn publish(&mut self, descriptor: &Value, tag: &str) {
        let watches: Vec<_> = self
            .clients
            .iter()
            .filter_map(|(id, client)| {
                client.watch.as_ref().map(|watch| {
                    (
                        *id,
                        watch.rid.clone(),
                        watch.generation,
                        watch.scopes.clone(),
                    )
                })
            })
            .collect();
        for (id, rid, generation, scopes) in watches {
            let Some(projected) = self.discovery_projection(id, descriptor, &scopes) else {
                continue;
            };
            let event = if tag == "upsert" {
                json!({"tag":"upsert","peer":projected})
            } else {
                json!({"tag":"remove","peer":descriptor["peer"]})
            };
            let event = json!({"v":2,"op":"roster.event","rid":rid,"event":event});
            let bytes = encoded_length(&event).unwrap_or(wire::MAX_BODY) + 4;
            let overflow = self
                .clients
                .get(&id)
                .and_then(|client| client.watch.as_ref())
                .is_none_or(|watch| watch.events >= 256 || watch.bytes + bytes > 128 * 1024);
            let queued = !overflow && self.queue(id, &event, BufferClass::Data, Some(generation));
            if queued
                && tag == "upsert"
                && let Some(remote) = self
                    .clients
                    .get_mut(&id)
                    .and_then(|client| client.remote.as_mut())
            {
                remote.refs.exported(&projected["peer"]);
            }
            if !queued {
                if let Some(client) = self.clients.get_mut(&id) {
                    client.watch = None;
                }
                let invalidated = json!({"v":2,"op":"roster.event","rid":rid,"event":{"tag":"invalidated","reason":"overflow"}});
                if !self.queue(id, &invalidated, BufferClass::Control, None) {
                    self.fail(id);
                }
            } else if let Some(watch) = self
                .clients
                .get_mut(&id)
                .and_then(|client| client.watch.as_mut())
            {
                watch.events += 1;
                watch.bytes += bytes;
            }
        }
    }

    fn destination(
        &self,
        origin: ConnectionId,
        target: &Value,
        scope: &str,
    ) -> Option<ConnectionId> {
        self.clients
            .iter()
            .find(|(_, client)| {
                !client.failed
                    && !client.closing
                    && client.descriptor.as_ref().is_some_and(|descriptor| {
                        descriptor["peer"] == *target && self.eligible(origin, descriptor, scope)
                    })
            })
            .map(|(id, _)| *id)
    }

    fn route(&mut self, origin: ConnectionId, request: &Value) -> Option<ConnectionId> {
        let target = &request["to"];
        let scope = request["scopeId"].as_str().unwrap_or("");
        // Deny before looking up existence, so policy failures cannot probe hidden routes.
        let machine = target["machineId"].as_str().unwrap_or("");
        let remote_origin = self.is_remote(origin);
        let authorized = if remote_origin {
            machine == self.config.machine_id
                && self.remote_allows(origin, scope, Verb::Push)
                && self
                    .remote_descriptor(origin, &request["from"])
                    .is_some_and(|own| member(own, scope))
        } else {
            // Another machine's gateway decides what reaches its sessions.
            self.descriptor(origin)
                .is_some_and(|own| member(own, scope))
                && (machine != self.config.machine_id
                    || self.config.permits(machine, scope, Permission::Push))
        };
        if !authorized {
            self.reject(origin, request, "forbidden", None);
            return None;
        }
        if request["message"]
            .get("replyTo")
            .is_some_and(|reply| reply["sender"] != request["to"])
        {
            self.reject(origin, request, "invalid_correlation", None);
            return None;
        }
        let destination = if remote_origin {
            self.clients
                .iter()
                .find(|(_, client)| {
                    !client.failed
                        && !client.closing
                        && client.descriptor.as_ref().is_some_and(|descriptor| {
                            descriptor["peer"] == *target && member(descriptor, scope)
                        })
                })
                .map(|(id, _)| *id)
        } else {
            self.destination(origin, target, scope).or_else(|| {
                self.remote_id().filter(|id| {
                    self.remote_descriptor(*id, target)
                        .is_some_and(|descriptor| member(descriptor, scope))
                })
            })
        };
        let Some(destination) = destination else {
            let code = if !remote_origin && self.link_down(machine) {
                "link_down"
            } else {
                "no_route"
            };
            self.reject(origin, request, code, None);
            return None;
        };
        Some(destination)
    }

    fn forward(&mut self, origin: ConnectionId, request: Value) {
        let Some(destination) = self.route(origin, &request) else {
            return;
        };
        let remote_origin = self.is_remote(origin);
        if self.forwards.len() >= MAX_OPERATIONS
            || (!remote_origin
                && self
                    .forwards
                    .values()
                    .filter(|forward| forward.origin == origin)
                    .count()
                    >= MAX_LOCAL_OPERATIONS)
        {
            self.reject(origin, &request, "overloaded", Some("operations"));
            return;
        }
        let Ok(rid) = random_id() else {
            self.reject(origin, &request, "unavailable", None);
            return;
        };
        let sender = if remote_origin {
            request["from"].clone()
        } else {
            self.descriptor(origin)
                .map_or(Value::Null, |descriptor| descriptor["peer"].clone())
        };
        let retained = encoded_length(&request).unwrap_or(wire::MAX_BODY);
        let Ok(reservation) = self.buffers.reserve(origin, BufferClass::Data, retained) else {
            self.reject(origin, &request, "overloaded", Some("buffers"));
            return;
        };
        let Some(hop) = crate::deadline::hop(&request["budgetMs"], OPERATION_TIMEOUT) else {
            drop(reservation);
            self.events
                .emit("expired", json!({"event":"expired","remote":remote_origin}));
            self.reject(origin, &request, "expired", None);
            return;
        };
        let mut forwarded = request.clone();
        forwarded["rid"] = Value::from(rid.clone());
        forwarded["budgetMs"] = Value::from(hop.forward_ms);
        forwarded["from"] = sender;
        if !self.is_remote(destination) {
            forwarded["op"] = Value::from("deliver");
        }
        if encoded_length(&forwarded).is_none_or(|length| {
            length + if self.is_remote(destination) { 3 } else { 0 } > wire::MAX_BODY
        }) {
            drop(reservation);
            self.reject(origin, &request, "delivery_too_large", None);
            return;
        }
        let sender_peer = if remote_origin {
            &request["from"]
        } else {
            &forwarded["from"]
        };
        let mut source = self.forward_permit(origin, sender_peer);
        let target = &request["to"];
        if let (Some(source), Some(target)) =
            (source.as_mut(), self.forward_permit(destination, target))
        {
            source.bind_target(target);
        }
        if let Some(remote) = self
            .clients
            .get(&destination)
            .and_then(|client| client.remote.as_ref())
        {
            remote.refs.compress(&mut forwarded);
        }
        if !self.queue_authorized(destination, &forwarded, BufferClass::Data, None, source) {
            drop(reservation);
            self.reject(origin, &request, "overloaded", Some("buffers"));
            return;
        }
        self.forwards.insert(
            rid,
            Forward {
                origin,
                destination,
                request,
                deadline: Instant::now() + hop.wait,
                reservation,
            },
        );
    }

    fn forward_permit(&self, id: ConnectionId, peer: &Value) -> Option<ForwardPermit> {
        let client = self.clients.get(&id)?;
        if let Some(remote) = &client.remote {
            let mut permit = remote
                .roster
                .iter()
                .find(|(descriptor, _, _)| descriptor["peer"] == *peer)
                .map(|(_, _, epoch)| epoch.permit())?;
            permit.bind_authority(client.source.permit());
            Some(permit)
        } else {
            Some(client.source.permit())
        }
    }

    fn reply(&mut self, id: ConnectionId, mut response: Value) {
        let rid = response["rid"].as_str().unwrap_or("");
        let Some(forward) = self.forwards.get(rid) else {
            return;
        }; // structurally valid retired controls allocate nothing
        let expected_op = if self.is_remote(forward.destination) {
            "send"
        } else {
            "deliver"
        };
        if id != forward.destination
            || response["forOp"] != expected_op
            || !matches_result(forward, &response["outcome"])
        {
            // A malformed/misbound receipt cannot authoritatively deny possible admission.
            let rid = rid.to_owned();
            self.retire(&rid, "protocol_error");
            self.fail(id);
            return;
        }
        let Some(forward) = self.forwards.remove(rid) else {
            return;
        };
        self.respond(forward.origin, &forward.request, response["outcome"].take());
        drop(forward.reservation);
    }

    fn retire(&mut self, rid: &str, code: &str) {
        let Some(forward) = self.forwards.remove(rid) else {
            return;
        };
        let outcome =
            json!({"tag":"unknown","messageId":forward.request["message"]["id"],"code":code});
        self.respond(forward.origin, &forward.request, outcome);
        drop(forward.reservation);
    }
    fn withdraw(&mut self, id: ConnectionId) {
        let remote = self
            .clients
            .get_mut(&id)
            .and_then(|client| client.remote.as_mut())
            .map(|remote| std::mem::take(&mut remote.roster));
        if let Some(roster) = remote {
            for (descriptor, charge, epoch) in roster {
                epoch.withdraw();
                self.publish(&descriptor, "remove");
                drop(charge);
            }
        }
        if let Some(client) = self.clients.get(&id) {
            client.source.withdraw();
        }
        let descriptor = self
            .clients
            .get_mut(&id)
            .and_then(|client| client.descriptor.take());
        if let Some(descriptor) = descriptor {
            self.publish(&descriptor, "remove");
        }
    }
    fn disconnect(&mut self, id: ConnectionId) {
        let remote = self.is_remote(id);
        self.withdraw(id);
        let affected: Vec<_> = self
            .forwards
            .iter()
            .filter(|(_, forward)| forward.origin == id || forward.destination == id)
            .map(|(rid, _)| rid.clone())
            .collect();
        for rid in affected {
            if self
                .forwards
                .get(&rid)
                .is_some_and(|forward| forward.origin == id)
            {
                if let Some(forward) = self.forwards.remove(&rid) {
                    drop(forward.reservation);
                }
            } else {
                self.retire(&rid, "unavailable");
            }
        }
        if let Some(client) = self.clients.remove(&id) {
            client.abort.abort();
        }
        self.buffers.close(id);
        if remote && let Some(link) = self.link.as_mut() {
            link.lost();
        }
    }
}

async fn remote_progress(link: Option<&mut Driver>) -> io::Result<Step> {
    match link {
        Some(link) => link.progress().await,
        None => std::future::pending().await,
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        if std::fs::symlink_metadata(&self.config.socket_path).is_ok_and(|metadata| {
            metadata.ino() == self.socket_inode && metadata.dev() == self.socket_device
        }) {
            let _ = std::fs::remove_file(&self.config.socket_path);
        }
    }
}
fn member(descriptor: &Value, scope: &str) -> bool {
    descriptor["scopeIds"]
        .as_array()
        .is_some_and(|scopes| scopes.iter().any(|value| value == scope))
}
fn project(descriptor: &Value, scopes: &[String]) -> Option<Value> {
    let projected: Vec<_> = descriptor["scopeIds"]
        .as_array()?
        .iter()
        .filter(|value| {
            value
                .as_str()
                .is_some_and(|scope| scopes.iter().any(|selected| selected == scope))
        })
        .cloned()
        .collect();
    if projected.is_empty() {
        None
    } else {
        Some(json!({"peer":descriptor["peer"],"label":descriptor["label"],"scopeIds":projected}))
    }
}
fn matches_result(forward: &Forward, outcome: &Value) -> bool {
    outcome["messageId"] == forward.request["message"]["id"]
        && (outcome["tag"] != "admitted"
            || (outcome["correlation"] == "none")
                == forward.request["message"].get("replyTo").is_none())
}
fn random_id() -> io::Result<String> {
    use std::fmt::Write;
    use std::io::Read;
    let mut bytes = [0_u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let mut id = String::with_capacity(32);
    for byte in bytes {
        write!(id, "{byte:02x}").map_err(io::Error::other)?;
    }
    Ok(id)
}
struct Counter(usize);
impl io::Write for Counter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .filter(|length| *length <= wire::MAX_BODY)
            .ok_or_else(|| io::Error::other("frame too large"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encoded_length(value: &Value) -> Option<usize> {
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).ok()?;
    Some(counter.0)
}
fn reject_symlink_ancestors(path: &Path) -> io::Result<()> {
    // Canonicalization would silently follow operator-supplied symlinks. Reject instead.
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(
            component,
            std::path::Component::ParentDir | std::path::Component::CurDir
        ) {
            return Err(denied());
        }
        current.push(component);
        if std::fs::symlink_metadata(&current)?
            .file_type()
            .is_symlink()
        {
            return Err(denied());
        }
    }
    Ok(())
}
fn current_uid() -> u32 {
    rustix::process::geteuid().as_raw()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn managed_runtime_without_loaded_file_fingerprint_refuses_guarded_registration() {
        let directory = PathBuf::from("/tmp")
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!(
                "gw-generation-{}",
                random_id().expect("isolated nonce")
            ));
        std::fs::create_dir(&directory).expect("isolated directory");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .expect("private directory");
        let config = Config::parse(&serde_json::to_vec(&json!({"machineId":"alpha","socketPath":directory.join("s"),"scopeIds":["team"],"policies":[]})).expect("config JSON")).expect("parsed config");
        assert!(
            config.loaded_config_sha256.is_none(),
            "parse is not a loaded file read"
        );
        let mut daemon = Daemon::bind(config).expect("isolated bind");
        daemon.managed = true;
        let (stream, _peer) = UnixStream::pair().expect("isolated sockets");
        let (events, _receive) = mpsc::channel(68);
        let mut tasks = JoinSet::new();
        daemon
            .accept(stream, &events, &mut tasks)
            .expect("fixture connection");
        let id = ConnectionId(1);
        let mut request = json!({"v":2,"op":"register","rid":"00000000000000000000000000000001","sessionId":"fixture","runtimeNonce":"00000000000000000000000000000002","scopeIds":["team"],"label":"fixture","expectedConfigSha256":"0".repeat(64)});
        daemon.handle(id, request.clone());
        assert!(
            daemon.descriptor(id).is_none(),
            "unknown fingerprint never admits guarded participant"
        );
        request
            .as_object_mut()
            .expect("request object")
            .remove("expectedConfigSha256");
        daemon.handle(id, request);
        assert!(
            daemon.descriptor(id).is_some(),
            "legacy still admits without a loaded fingerprint"
        );
        drop(daemon);
        tasks.abort_all();
        std::fs::remove_dir_all(directory).expect("cleanup isolated fixture");
    }

    #[tokio::test]
    async fn retired_watch_completion_cannot_release_reused_rid_watch_budget() {
        let directory = PathBuf::from("/tmp")
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!(
                "gw-watch-{}",
                random_id().expect("isolated directory nonce")
            ));
        std::fs::create_dir(&directory).expect("isolated directory");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .expect("private fixture directory");
        let config = Config::parse(&serde_json::to_vec(&json!({"machineId":"alpha","socketPath":directory.join("s"),"scopeIds":["team"],"policies":[{"machineId":"alpha","scopeId":"team","permissions":["discover"]}]})).expect("fixture encoding")).expect("fixture policy");
        let mut daemon = Daemon::bind(config).expect("isolated bind");
        let (stream, _peer) = UnixStream::pair().expect("isolated socketpair");
        let (events, _receive) = mpsc::channel(68);
        let mut tasks = JoinSet::new();
        daemon
            .accept(stream, &events, &mut tasks)
            .expect("fixture connection");
        let id = ConnectionId(1);
        daemon.handle(id, json!({"v":2,"op":"register","rid":"00000000000000000000000000000001","sessionId":"fixture","runtimeNonce":"00000000000000000000000000000002","scopeIds":["team"],"label":"fixture"}));
        let discover = json!({"v":2,"op":"discover","rid":"00000000000000000000000000000003","scopeIds":["team"],"watch":true});
        daemon.handle(id, discover.clone());
        let descriptor = daemon.descriptor(id).expect("registered fixture").clone();
        daemon.publish(&descriptor, "upsert");
        let old_watch = daemon.clients[&id]
            .watch
            .as_ref()
            .expect("old watch")
            .generation;
        let old_bytes = daemon.clients[&id].watch.as_ref().expect("old watch").bytes;
        daemon.handle(id, json!({"v":2,"op":"unwatch","rid":"00000000000000000000000000000004","watchRid":discover["rid"]}));
        daemon.handle(id, discover);
        daemon.publish(&descriptor, "upsert");
        let before = daemon.clients[&id]
            .watch
            .as_ref()
            .expect("replacement watch");
        let expected = (before.events, before.bytes);
        daemon.event(Event::Written {
            id,
            watch: old_watch,
            bytes: old_bytes,
        });
        let after = daemon.clients[&id]
            .watch
            .as_ref()
            .expect("replacement watch survives");
        assert_eq!(
            (after.events, after.bytes),
            expected,
            "old completion must not release replacement watch quota"
        );
        daemon
            .clients
            .get_mut(&id)
            .expect("fixture client")
            .watch
            .as_mut()
            .expect("replacement watch")
            .events = 256;
        daemon.publish(&descriptor, "upsert");
        assert!(
            daemon.clients[&id].watch.is_none(),
            "full watch must invalidate rather than silently drop an event"
        );
        assert!(
            !daemon.clients[&id].failed,
            "bounded explicit invalidation fits available control headroom"
        );
        drop(daemon);
        drop(tasks);
        std::fs::remove_dir_all(directory).expect("remove isolated directory");
    }
    #[tokio::test(start_paused = true)]
    async fn remote_liveness_has_one_ping_and_only_complete_valid_frames_reset_progress() {
        let directory = PathBuf::from("/tmp")
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!("gw-live-{}", random_id().expect("isolated nonce")));
        std::fs::create_dir(&directory).expect("isolated directory");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .expect("private directory");
        let config = Config::parse(&serde_json::to_vec(&json!({"machineId":"alpha","socketPath":directory.join("s"),"scopeIds":["team"],"policies":[]})).expect("fixture encoding")).expect("fixture policy");
        let mut daemon = Daemon::bind(config).expect("isolated bind");
        let (stream, _peer) = UnixStream::pair().expect("isolated socketpair");
        let (events, _receive) = mpsc::channel(68);
        let mut tasks = JoinSet::new();
        daemon
            .accept(stream, &events, &mut tasks)
            .expect("fixture connection");
        let id = ConnectionId(1);
        daemon.clients.get_mut(&id).expect("fixture client").remote = Some(Remote {
            roster: Vec::new(),
            snapshot_rid: "00000000000000000000000000000001".to_owned(),
            established: true,
            last_progress: Instant::now(),
            ping: None,
            scopes: vec!["team".to_owned()],
            peer: crate::tailscale::tests_support::peer("beta", &serde_json::json!([])),
            refs: crate::intern::Refs::default(),
        });
        tokio::time::advance(Duration::from_secs(29)).await;
        daemon.liveness();
        assert!(
            daemon.clients[&id]
                .remote
                .as_ref()
                .expect("remote fixture")
                .ping
                .is_none()
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        daemon.liveness();
        let ping = daemon.clients[&id]
            .remote
            .as_ref()
            .expect("remote fixture")
            .ping
            .clone();
        assert!(ping.is_some());
        daemon.liveness();
        assert_eq!(
            daemon.clients[&id]
                .remote
                .as_ref()
                .expect("remote fixture")
                .ping,
            ping,
            "do not stack pending pings"
        );
        let stale = json!({"v":2,"op":"result","rid":"00000000000000000000000000000099","forOp":"ping","outcome":{"tag":"ok","value":{}}});
        let stale = wire::decode_body(
            &serde_json::to_vec(&stale).expect("valid fixture encoding"),
            Role::RemoteLink,
        )
        .expect("complete authenticated structural fixture");
        daemon.remote_frame(id, stale);
        assert!(
            daemon.clients[&id]
                .remote
                .as_ref()
                .expect("remote fixture")
                .ping
                .is_none(),
            "valid stale control retires pending ping without allocating an operation"
        );
        assert!(daemon.forwards.is_empty());
        tokio::time::advance(Duration::from_secs(89)).await;
        daemon.liveness();
        assert!(!daemon.clients[&id].failed);
        tokio::time::advance(Duration::from_secs(1)).await;
        daemon.liveness();
        assert!(
            daemon.clients[&id].failed,
            "no complete valid progress for 90s withdraws the link"
        );
        drop(daemon);
        drop(tasks);
        std::fs::remove_dir_all(directory).expect("remove isolated directory");
    }
    async fn read_frame(stream: &mut UnixStream) -> Value {
        use tokio::io::AsyncReadExt;
        let mut header = [0_u8; 4];
        tokio::time::timeout(Duration::from_secs(2), stream.read_exact(&mut header))
            .await
            .expect("bounded frame")
            .expect("frame header");
        let mut body = vec![0; usize::try_from(u32::from_be_bytes(header)).expect("small frame")];
        stream.read_exact(&mut body).await.expect("frame body");
        serde_json::from_slice(&body).expect("frame JSON")
    }

    fn remote_daemon(name: &str) -> (Daemon, PathBuf, crate::tailscale::fake::Fake) {
        let directory = PathBuf::from("/tmp")
            .canonicalize()
            .expect("canonical temporary directory")
            .join(format!("gw-{name}-{}", random_id().expect("nonce")));
        std::fs::create_dir(&directory).expect("isolated directory");
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .expect("private directory");
        let fake = crate::tailscale::fake::Fake::new(crate::tailscale::fake::SCRIPT);
        let config = Config::parse(&serde_json::to_vec(&json!({"machineId":"alpha","socketPath":directory.join("s"),"scopeIds":["team"],"policies":[{"machineId":"alpha","scopeId":"team","permissions":["discover","push"]}],"remote":{"endpoint":{"mode":"connect","address":"127.0.0.1:9"},"tailscale":fake.program()}})).expect("config JSON")).expect("remote config");
        let daemon = Daemon::bind(config).expect("binds; the link never runs here");
        assert!(
            daemon.remote_degraded_reason().is_none(),
            "trusted fake CLI"
        );
        assert!(
            daemon.link_frame("x").is_none(),
            "no link.state names a machine before whois identified one"
        );
        (daemon, directory, fake)
    }

    #[tokio::test]
    async fn every_session_gets_link_state_and_fails_fast_with_link_down() {
        let (mut daemon, directory, _fake) = remote_daemon("link-down");
        daemon
            .link
            .as_mut()
            .expect("configured link")
            .identified("beta");
        let (events, _receive) = mpsc::channel(68);
        let mut tasks = JoinSet::new();
        let (first, mut first_peer) = UnixStream::pair().expect("sockets");
        let (second, mut second_peer) = UnixStream::pair().expect("sockets");
        daemon
            .accept(first, &events, &mut tasks)
            .expect("first connection");
        daemon
            .accept(second, &events, &mut tasks)
            .expect("second connection");
        let register = |nonce: &str| json!({"v":2,"op":"register","rid":"00000000000000000000000000000001","sessionId":"s","runtimeNonce":nonce,"scopeIds":["team"],"label":"fixture"});
        daemon.handle(
            ConnectionId(1),
            register("00000000000000000000000000000002"),
        );
        daemon.handle(
            ConnectionId(2),
            register("00000000000000000000000000000003"),
        );
        for peer in [&mut first_peer, &mut second_peer] {
            assert_eq!(read_frame(peer).await["outcome"]["tag"], "ok");
            let state = read_frame(peer).await;
            assert_eq!(state["op"], "link.state");
            assert_eq!(state["machineId"], "beta");
            assert_eq!(state["state"], "probing", "dialing, never up");
            assert_eq!(state["rid"], "00000000000000000000000000000001");
        }
        let send = |rid: &str| json!({"v":2,"op":"send","rid":rid,"to":{"machineId":"beta","sessionId":"remote","runtimeNonce":"00000000000000000000000000000009"},"scopeId":"team","budgetMs":15000,"message":{"id":"0000000000000000000000000000000a","kind":"update","content":"hi","format":"text"}});
        daemon.handle(ConnectionId(1), send("00000000000000000000000000000004"));
        let refused = read_frame(&mut first_peer).await;
        assert_eq!(refused["outcome"]["tag"], "not_admitted");
        assert_eq!(
            refused["outcome"]["code"], "link_down",
            "fails fast with a distinct code"
        );
        assert!(wire::validate_value(&refused, Role::LocalClient).is_ok());
        daemon.handle(ConnectionId(2), send("00000000000000000000000000000005"));
        assert_eq!(
            read_frame(&mut second_peer).await["outcome"]["code"],
            "link_down",
            "no session is left on the old no_route code"
        );
        daemon.announce_link();
        daemon.announce_link();
        drop(daemon);
        tasks.abort_all();
        std::fs::remove_dir_all(directory).expect("cleanup");
    }
}
