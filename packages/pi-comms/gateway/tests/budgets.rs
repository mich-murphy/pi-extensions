//! Observable resource accounting and reservation atomicity.
use pi_gateway::budget::{BufferClass, Buffers, ConnectionId, ConnectionKind};

mod support;

#[test]
fn control_headroom_and_generation_fencing() {
    let mut buffers = Buffers::new();
    let connection = ConnectionId(1);
    buffers.open(connection, ConnectionKind::Local).unwrap();
    let data = buffers
        .reserve(connection, BufferClass::Data, 224 * 1024)
        .unwrap();
    assert!(buffers.reserve(connection, BufferClass::Data, 1).is_err());
    let control = buffers
        .reserve(connection, BufferClass::Control, 32 * 1024)
        .unwrap();
    assert!(
        buffers
            .reserve(connection, BufferClass::Control, 1)
            .is_err()
    );
    buffers.close(connection);
    assert!(buffers.open(connection, ConnectionKind::Local).is_err());
    buffers
        .open(ConnectionId(2), ConnectionKind::Local)
        .unwrap();
    buffers.release(data);
    buffers.release(control);
    assert_eq!(buffers.retained_bytes(), 0);
}

#[test]
fn aggregate_is_not_thirty_reserved_entitlements() {
    let mut buffers = Buffers::new();
    let mut reservations = Vec::new();
    for generation in 1..=30 {
        let connection = ConnectionId(generation);
        buffers.open(connection, ConnectionKind::Local).unwrap();
        reservations.push(
            buffers
                .reserve(connection, BufferClass::Data, 224 * 1024)
                .unwrap(),
        );
    }
    let remote = ConnectionId(31);
    buffers.open(remote, ConnectionKind::Remote).unwrap();
    reservations.push(
        buffers
            .reserve(remote, BufferClass::Data, 896 * 1024)
            .unwrap(),
    );
    // Control has its own 256 KiB aggregate ceiling, even below the absolute cap.
    for generation in 1..=8 {
        reservations.push(
            buffers
                .reserve(ConnectionId(generation), BufferClass::Control, 32 * 1024)
                .unwrap(),
        );
    }
    assert!(buffers.reserve(remote, BufferClass::Control, 1).is_err());
    for reservation in reservations {
        buffers.release(reservation);
    }
    assert_eq!(buffers.retained_bytes(), 0);
}

#[hegel::test(support::property_settings(200, 12345))]
fn arbitrary_header_never_accepts_out_of_range(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let bytes = tc.draw(gs::vecs(gs::integers::<u8>()).max_size(64));
    if let Ok(header) = <[u8; 4]>::try_from(bytes.as_slice()) {
        let declared = u32::from_be_bytes(header);
        assert_eq!(
            pi_gateway::wire::body_length(header).is_ok(),
            (1..=32764).contains(&declared)
        );
    }
}

#[hegel::test(support::property_settings(200, 23456))]
fn reservation_sequences_preserve_atomic_accounting(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let sizes = tc.draw(gs::vecs(gs::integers::<u16>()).max_size(64));
    let mut buffers = Buffers::new();
    let connection = ConnectionId(1);
    buffers
        .open(connection, ConnectionKind::Local)
        .expect("fresh generation must open");
    let mut reservations = Vec::new();
    let mut retained = 0;
    for size in sizes {
        let bytes = usize::from(size);
        let result = buffers.reserve(connection, BufferClass::Data, bytes);
        assert_eq!(result.is_ok(), retained + bytes <= 224 * 1024);
        if let Ok(reservation) = result {
            retained += bytes;
            reservations.push(reservation);
        }
        assert_eq!(buffers.retained_bytes(), retained);
    }
    let control = buffers
        .reserve(connection, BufferClass::Control, 32 * 1024)
        .expect("reserved control headroom must survive data saturation");
    for reservation in reservations {
        buffers.release(reservation);
    }
    assert_eq!(buffers.retained_bytes(), 32 * 1024);
    buffers.release(control);
    assert_eq!(buffers.retained_bytes(), 0);
}

#[hegel::test(support::property_settings(200, 34567))]
fn control_flood_cannot_borrow_data_capacity(tc: hegel::TestCase) {
    use hegel::generators as gs;
    let sizes = tc.draw(gs::vecs(gs::integers::<u16>()).max_size(64));
    let mut buffers = Buffers::new();
    let connection = ConnectionId(1);
    buffers
        .open(connection, ConnectionKind::Local)
        .expect("fresh generation must open");
    let mut retained = 0;
    let mut reservations = Vec::new();
    for size in sizes {
        let bytes = usize::from(size);
        let result = buffers.reserve(connection, BufferClass::Control, bytes);
        assert_eq!(result.is_ok(), retained + bytes <= 32 * 1024);
        if let Ok(reservation) = result {
            retained += bytes;
            reservations.push(reservation);
        }
        assert_eq!(buffers.retained_bytes(), retained);
    }
    for reservation in reservations {
        buffers.release(reservation);
    }
    assert_eq!(buffers.retained_bytes(), 0);
}

#[test]
fn remote_control_has_an_independent_128k_ceiling() {
    let mut buffers = Buffers::new();
    let connection = ConnectionId(1);
    buffers.open(connection, ConnectionKind::Remote).unwrap();
    let control = buffers
        .reserve(connection, BufferClass::Control, 128 * 1024)
        .unwrap();
    assert!(
        buffers
            .reserve(connection, BufferClass::Control, 1)
            .is_err()
    );
    let data = buffers
        .reserve(connection, BufferClass::Data, 896 * 1024)
        .unwrap();
    buffers.release(control);
    buffers.release(data);
    assert_eq!(buffers.retained_bytes(), 0);
}

#[test]
fn retiring_a_connection_does_not_release_buffers_still_owned_by_pipeline() {
    let mut buffers = Buffers::new();
    let id = ConnectionId(1);
    buffers.open(id, ConnectionKind::Local).unwrap();
    let charge = buffers.reserve(id, BufferClass::Data, 4096).unwrap();
    buffers.retire(id);
    assert_eq!(
        buffers.retained_bytes(),
        4096,
        "retirement must not undercharge task/channel buffers"
    );
    assert!(buffers.reserve(id, BufferClass::Control, 1).is_err());
    buffers.release(charge);
    assert_eq!(buffers.retained_bytes(), 0);
    assert!(buffers.reserve(id, BufferClass::Control, 1).is_err());
}
