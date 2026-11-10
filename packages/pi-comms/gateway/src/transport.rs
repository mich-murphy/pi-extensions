//! Capped async stream tasks with byte-accounted buffers and nonblocking event offers.
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::budget::{
    BufferClass, BufferReservation, Buffers, ConnectionId, ConnectionKind, ReserveBufferError,
};
use crate::wire;

const PROGRESS: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
pub(crate) struct Accounting(Arc<Mutex<Buffers>>);
#[derive(Debug)]
pub(crate) struct Charge {
    ledger: Accounting,
    reservation: Option<BufferReservation>,
}
impl Drop for Charge {
    fn drop(&mut self) {
        if let Some(reservation) = self.reservation.take() {
            self.ledger
                .0
                .lock()
                .expect("buffer ledger poisoned")
                .release(reservation);
        }
    }
}
impl Accounting {
    pub(crate) fn open(
        &self,
        id: ConnectionId,
        kind: ConnectionKind,
    ) -> Result<(), ReserveBufferError> {
        self.0
            .lock()
            .expect("buffer ledger poisoned")
            .open(id, kind)
    }
    pub(crate) fn reserve(
        &self,
        id: ConnectionId,
        class: BufferClass,
        bytes: usize,
    ) -> Result<Charge, ReserveBufferError> {
        let reservation = self
            .0
            .lock()
            .expect("buffer ledger poisoned")
            .reserve(id, class, bytes)?;
        Ok(Charge {
            ledger: self.clone(),
            reservation: Some(reservation),
        })
    }
    pub(crate) fn close(&self, id: ConnectionId) {
        self.0.lock().expect("buffer ledger poisoned").retire(id);
    }
}

#[derive(Debug)]
pub(crate) struct ForwardPermit {
    source: watch::Receiver<bool>,
    target: Option<watch::Receiver<bool>>,
    authority: Option<watch::Receiver<bool>>,
    expires: Option<Instant>,
}
impl ForwardPermit {
    pub(crate) fn bind_target(&mut self, target: Self) {
        self.target = Some(target.source);
        self.expires = self.expires.into_iter().chain(target.expires).min();
        if target.authority.is_some() {
            self.authority = target.authority;
        }
    }
    pub(crate) fn bind_authority(&mut self, authority: Self) {
        self.authority = Some(authority.source);
    }
    pub(crate) fn expire_at(&mut self, deadline: Instant) {
        self.expires = Some(deadline);
    }
    fn revoked(&self) -> bool {
        self.expires.is_some_and(|expiry| expiry <= Instant::now())
            || !*self.source.borrow()
            || self.target.as_ref().is_some_and(|target| !*target.borrow())
            || self
                .authority
                .as_ref()
                .is_some_and(|authority| !*authority.borrow())
    }
    async fn changed(&mut self) {
        tokio::select! {
            _ = self.source.changed() => {},
            () = changed(&mut self.target) => {},
            () = changed(&mut self.authority) => {},
        }
    }
}

async fn changed(receiver: &mut Option<watch::Receiver<bool>>) {
    match receiver {
        Some(receiver) => {
            let _ = receiver.changed().await;
        }
        None => std::future::pending().await,
    }
}

/// A private, non-reusable authorization lifetime; wire IDs cannot select its identity.
#[derive(Debug)]
pub(crate) struct SourceEpoch(watch::Sender<bool>);
impl SourceEpoch {
    pub(crate) fn new() -> Self {
        Self(watch::channel(true).0)
    }
    pub(crate) fn permit(&self) -> ForwardPermit {
        ForwardPermit {
            source: self.0.subscribe(),
            target: None,
            authority: None,
            expires: None,
        }
    }
    pub(crate) fn active(&self) -> bool {
        *self.0.borrow()
    }
    // Dropping either owner withdraws the same connection generation synchronously.
    pub(crate) fn shared_guard(&self) -> Self {
        Self(self.0.clone())
    }
    pub(crate) fn withdraw(&self) {
        self.0.send_replace(false);
    }
}
impl Drop for SourceEpoch {
    fn drop(&mut self) {
        self.withdraw();
    }
}

#[derive(Debug)]
pub(crate) struct Output {
    pub(crate) bytes: Vec<u8>,
    pub(crate) enqueued: Instant,
    pub(crate) reservation: Charge,
    pub(crate) watch: Option<u64>,
    pub(crate) finish: bool,
    pub(crate) source: Option<ForwardPermit>,
}
#[derive(Debug)]
pub(crate) enum Event {
    Frame {
        id: ConnectionId,
        bytes: Vec<u8>,
        charge: Charge,
    },
    Written {
        id: ConnectionId,
        watch: u64,
        bytes: usize,
    },
}

async fn read_frames<R: AsyncRead + Unpin>(
    id: ConnectionId,
    reader: &mut R,
    accounting: &Accounting,
    events: &mpsc::Sender<Event>,
) -> io::Result<()> {
    loop {
        let mut header = [0_u8; 4];
        // No timer is created while waiting for the first byte on an idle stream.
        reader.read_exact(&mut header[..1]).await?;
        let deadline = Instant::now() + PROGRESS;
        tokio::time::timeout_at(deadline, reader.read_exact(&mut header[1..])).await??;
        let length = wire::body_length(header).map_err(io::Error::other)?;
        let charge = accounting
            .reserve(id, BufferClass::Data, length)
            .map_err(io::Error::other)?;
        let mut bytes = vec![0; length];
        tokio::time::timeout_at(deadline, reader.read_exact(&mut bytes)).await??;
        events
            .try_send(Event::Frame { id, bytes, charge })
            .map_err(io::Error::other)?;
    }
}

pub(crate) async fn connection<S: AsyncRead + AsyncWrite + Unpin>(
    id: ConnectionId,
    stream: S,
    accounting: Accounting,
    events: mpsc::Sender<Event>,
    mut output: mpsc::Receiver<Output>,
) {
    let (mut reader, mut writer) = tokio::io::split(stream);
    let inbound = read_frames(id, &mut reader, &accounting, &events);
    let outbound = async {
        while let Some(mut frame) = output.recv().await {
            if frame.source.as_ref().is_some_and(ForwardPermit::revoked) {
                drop(frame.bytes);
                drop(frame.reservation);
                continue;
            }
            // AsyncWrite may accept plaintext while retaining ciphertext internally.
            // Flush shares the original enqueue deadline and withdrawal guard; only
            // then may Written release watch quota or the serialized-byte charge.
            let deadline = frame
                .source
                .as_ref()
                .and_then(|permit| permit.expires)
                .map_or(frame.enqueued + PROGRESS, |expiry| {
                    expiry.min(frame.enqueued + PROGRESS)
                });
            let write = tokio::time::timeout_at(deadline, async {
                writer.write_all(&frame.bytes).await?;
                writer.flush().await
            });
            if let Some(permit) = frame.source.as_mut() {
                tokio::select! {
                    biased;
                    () = permit.changed() => return Err(io::Error::new(io::ErrorKind::PermissionDenied, "forwarding authority withdrawn")),
                    result = write => { result??; }
                }
            } else {
                write.await??;
            }
            if let Some(watch) = frame.watch {
                events
                    .try_send(Event::Written {
                        id,
                        watch,
                        bytes: frame.bytes.len(),
                    })
                    .map_err(io::Error::other)?;
            }
            drop(frame.bytes);
            drop(frame.reservation);
            if frame.finish {
                return writer.shutdown().await;
            }
        }
        writer.shutdown().await
    };
    tokio::select! { _ = inbound => {}, _ = outbound => {} }
}

/// Pending without allocating a timer when there is no real deadline.
pub(crate) async fn next_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll, Wake, Waker};
    use tokio::net::UnixStream;

    struct WakeCount(AtomicUsize);
    impl Wake for WakeCount {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn idle_connection_has_no_periodic_wakeup() {
        let accounting = Accounting::default();
        let id = ConnectionId(1);
        accounting
            .open(id, ConnectionKind::Local)
            .expect("fresh connection ledger");
        let (stream, _peer) = UnixStream::pair().expect("isolated socketpair");
        let (events, _receive) = mpsc::channel(2);
        let (_send, output) = mpsc::channel(2);
        let mut connection = Box::pin(connection(id, stream, accounting, events, output));
        let count = Arc::new(WakeCount(AtomicUsize::new(0)));
        let waker = Waker::from(Arc::clone(&count));
        let mut context = Context::from_waker(&waker);
        assert!(matches!(
            connection.as_mut().poll(&mut context),
            Poll::Pending
        ));
        tokio::task::yield_now().await;
        // Drain any initial registration readiness notification before measuring idle time.
        let _ = connection.as_mut().poll(&mut context);
        count.0.store(0, Ordering::SeqCst);
        tokio::time::advance(Duration::from_secs(3600)).await;
        assert_eq!(
            count.0.load(Ordering::SeqCst),
            0,
            "idle connection must not schedule a repeating timer"
        );
        assert!(matches!(
            connection.as_mut().poll(&mut context),
            Poll::Pending
        ));
    }
    #[tokio::test(start_paused = true)]
    async fn partial_header_schedules_one_real_assembly_deadline() {
        let accounting = Accounting::default();
        let id = ConnectionId(1);
        accounting
            .open(id, ConnectionKind::Local)
            .expect("fresh connection ledger");
        let (stream, mut peer) = UnixStream::pair().expect("isolated socketpair");
        let (events, _receive) = mpsc::channel(2);
        let (_send, output) = mpsc::channel(2);
        let mut connection = Box::pin(connection(id, stream, accounting, events, output));
        let count = Arc::new(WakeCount(AtomicUsize::new(0)));
        let waker = Waker::from(Arc::clone(&count));
        let mut context = Context::from_waker(&waker);
        peer.write_all(&[0]).await.expect("first header byte");
        let _ = connection.as_mut().poll(&mut context);
        tokio::task::yield_now().await;
        assert!(matches!(
            connection.as_mut().poll(&mut context),
            Poll::Pending
        ));
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(
            matches!(connection.as_mut().poll(&mut context), Poll::Ready(())),
            "a partial header must expire without a polling loop"
        );
    }
    #[tokio::test(start_paused = true)]
    async fn partial_frame_is_assembled_for_exactly_five_seconds_from_its_first_byte() {
        for partial_body in [false, true] {
            let accounting = Accounting::default();
            let id = ConnectionId(1);
            accounting
                .open(id, ConnectionKind::Local)
                .expect("fresh connection ledger");
            let (stream, mut peer) = tokio::io::duplex(64);
            let (events, _receive) = mpsc::channel(2);
            let (_send, output) = mpsc::channel(2);
            let task = tokio::spawn(connection(id, stream, accounting, events, output));
            // One header byte, or a complete header announcing a body that never arrives.
            let prefix: &[u8] = if partial_body { &[0, 0, 0, 4, 1] } else { &[0] };
            peer.write_all(prefix).await.expect("partial frame prefix");
            tokio::task::yield_now().await;
            tokio::time::advance(Duration::from_millis(4_999)).await;
            tokio::task::yield_now().await;
            assert!(
                !task.is_finished(),
                "a slow sender keeps its frame open until the five-second deadline"
            );
            tokio::time::advance(Duration::from_millis(1)).await;
            tokio::task::yield_now().await;
            assert!(
                task.is_finished(),
                "the stalled frame closes the connection at five seconds"
            );
            task.await.expect("connection task exits cleanly");
        }
    }
    #[tokio::test]
    async fn withdrawn_source_drops_unwritten_frame_without_releasing_charge_early() {
        let accounting = Accounting::default();
        let id = ConnectionId(1);
        accounting
            .open(id, ConnectionKind::Local)
            .expect("fresh destination");
        let source = SourceEpoch::new();
        let permit = source.permit();
        let reservation = accounting
            .reserve(id, BufferClass::Data, 8)
            .expect("frame reservation");
        let (send, receive) = mpsc::channel(1);
        send.try_send(Output {
            bytes: vec![1; 8],
            enqueued: Instant::now(),
            reservation,
            watch: None,
            finish: false,
            source: Some(permit),
        })
        .expect("bounded output offer");
        assert_eq!(accounting.0.lock().expect("ledger").retained_bytes(), 8);
        source.withdraw();
        drop(send);
        let (stream, mut peer) = tokio::io::duplex(32);
        let (events, _receive_events) = mpsc::channel(2);
        let mut received = Vec::new();
        let ((), result) = tokio::join!(
            connection(id, stream, accounting.clone(), events, receive),
            peer.read_to_end(&mut received)
        );
        result.expect("destination observes clean end without an unauthorized frame");
        assert!(
            received.is_empty(),
            "withdrawn queued bytes must never reach destination"
        );
        assert_eq!(accounting.0.lock().expect("ledger").retained_bytes(), 0);
    }

    #[tokio::test]
    async fn withdrawal_during_partial_write_closes_destination_and_drops_remaining_bytes() {
        let accounting = Accounting::default();
        let id = ConnectionId(1);
        accounting
            .open(id, ConnectionKind::Local)
            .expect("fresh destination");
        let source = SourceEpoch::new();
        let reservation = accounting
            .reserve(id, BufferClass::Data, 8)
            .expect("frame reservation");
        let (send, receive) = mpsc::channel(1);
        send.try_send(Output {
            bytes: vec![1; 8],
            enqueued: Instant::now(),
            reservation,
            watch: None,
            finish: false,
            source: Some(source.permit()),
        })
        .expect("bounded output offer");
        let (stream, mut peer) = tokio::io::duplex(1);
        let (events, _receive_events) = mpsc::channel(2);
        let task = tokio::spawn(connection(id, stream, accounting.clone(), events, receive));
        assert_eq!(peer.read_u8().await.expect("first partial byte"), 1);
        source.withdraw();
        task.await.expect("bounded connection task exits");
        let mut remainder = Vec::new();
        peer.read_to_end(&mut remainder)
            .await
            .expect("partial-frame destination closed");
        assert!(
            remainder.is_empty(),
            "withdrawal must stop the blocked write, not resume remaining frame bytes"
        );
        assert_eq!(accounting.0.lock().expect("ledger").retained_bytes(), 0);
        drop(send);
    }
    #[tokio::test(start_paused = true)]
    async fn buffered_flush_keeps_charge_and_watch_pending_until_same_absolute_deadline() {
        let accounting = Accounting::default();
        let id = ConnectionId(1);
        accounting
            .open(id, ConnectionKind::Local)
            .expect("fresh destination");
        let reservation = accounting
            .reserve(id, BufferClass::Data, 8)
            .expect("frame charge");
        let (send, receive) = mpsc::channel(1);
        // The frame waited two seconds before the connection task can write it.
        let enqueued = Instant::now();
        tokio::time::advance(Duration::from_secs(2)).await;
        send.try_send(Output {
            bytes: vec![1; 8],
            enqueued,
            reservation,
            watch: Some(7),
            finish: false,
            source: None,
        })
        .expect("bounded output");
        let (stream, mut peer) = tokio::io::duplex(1);
        let buffered = tokio::io::BufStream::with_capacity(32, 32, stream);
        let (events, mut received) = mpsc::channel(2);
        let task = tokio::spawn(connection(
            id,
            buffered,
            accounting.clone(),
            events,
            receive,
        ));
        tokio::task::yield_now().await;
        assert_eq!(
            accounting.0.lock().expect("ledger").retained_bytes(),
            8,
            "accepted-but-unflushed bytes remain charged"
        );
        assert!(
            received.try_recv().is_err(),
            "Written must not precede flush"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        assert!(
            !task.is_finished(),
            "flush has not reached the original five-second deadline"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        task.await.expect("blocked flush times out at enqueue + 5s");
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes)
            .await
            .expect("closed buffered stream");
        assert_eq!(
            bytes,
            vec![1],
            "blocked flush cannot drain retained remainder after timeout"
        );
        assert!(received.try_recv().is_err());
        assert_eq!(accounting.0.lock().expect("ledger").retained_bytes(), 0);
        drop(send);
    }

    #[tokio::test]
    async fn target_withdrawal_during_buffered_flush_closes_without_forwarding_remainder() {
        let accounting = Accounting::default();
        let id = ConnectionId(1);
        accounting
            .open(id, ConnectionKind::Local)
            .expect("fresh destination");
        let source = SourceEpoch::new();
        let target = SourceEpoch::new();
        let mut permit = source.permit();
        permit.bind_target(target.permit());
        let reservation = accounting
            .reserve(id, BufferClass::Data, 8)
            .expect("frame charge");
        let (send, receive) = mpsc::channel(1);
        send.try_send(Output {
            bytes: vec![1; 8],
            enqueued: Instant::now(),
            reservation,
            watch: Some(7),
            finish: false,
            source: Some(permit),
        })
        .expect("bounded output");
        let (stream, mut peer) = tokio::io::duplex(1);
        let buffered = tokio::io::BufStream::with_capacity(32, 32, stream);
        let (events, mut received) = mpsc::channel(2);
        let task = tokio::spawn(connection(
            id,
            buffered,
            accounting.clone(),
            events,
            receive,
        ));
        tokio::task::yield_now().await;
        assert_eq!(accounting.0.lock().expect("ledger").retained_bytes(), 8);
        assert!(
            received.try_recv().is_err(),
            "buffered write is not a flushed write"
        );
        target.withdraw();
        task.await.expect("withdrawal stops blocked flush");
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes)
            .await
            .expect("closed buffered stream");
        assert_eq!(
            bytes,
            vec![1],
            "only the already-forwarded byte can survive withdrawal"
        );
        assert!(received.try_recv().is_err());
        assert_eq!(accounting.0.lock().expect("ledger").retained_bytes(), 0);
        drop(send);
    }
    #[tokio::test(start_paused = true)]
    async fn credential_expiry_bounds_existing_flush_timer_even_before_router_observes_link_end() {
        let accounting = Accounting::default();
        let id = ConnectionId(1);
        accounting
            .open(id, ConnectionKind::Local)
            .expect("fresh destination");
        let authority = SourceEpoch::new();
        let source = SourceEpoch::new();
        let mut permit = source.permit();
        permit.bind_authority(authority.permit());
        permit.expire_at(Instant::now() + Duration::from_secs(3));
        let reservation = accounting
            .reserve(id, BufferClass::Data, 8)
            .expect("frame charge");
        let (send, receive) = mpsc::channel(1);
        send.try_send(Output {
            bytes: vec![1; 8],
            enqueued: Instant::now(),
            reservation,
            watch: Some(7),
            finish: false,
            source: Some(permit),
        })
        .expect("bounded output");
        let (stream, mut peer) = tokio::io::duplex(1);
        let buffered = tokio::io::BufStream::with_capacity(32, 32, stream);
        let (events, mut received) = mpsc::channel(2);
        let task = tokio::spawn(connection(
            id,
            buffered,
            accounting.clone(),
            events,
            receive,
        ));
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(3)).await;
        task.await
            .expect("credential expiry ends pending flush before five-second write timeout");
        assert!(
            authority.active(),
            "test intentionally delays route-owner withdrawal observation"
        );
        let mut bytes = Vec::new();
        peer.read_to_end(&mut bytes)
            .await
            .expect("expired buffered stream closed");
        assert_eq!(bytes, vec![1]);
        assert!(
            received.try_recv().is_err(),
            "expired flush cannot report successful forwarding"
        );
        assert_eq!(accounting.0.lock().expect("ledger").retained_bytes(), 0);
        drop(send);
    }
}
