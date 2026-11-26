//! Pinned raw-public-key mutual TLS (RFC 7250): each side accepts exactly one Ed25519 key.
//!
//! There is no certificate, name, expiry or revocation: the peer's identity is the one public
//! key the operator pinned. Only TLS 1.3 and Ed25519 signatures are accepted, and a presented
//! key must equal the pinned key's `SubjectPublicKeyInfo` byte for byte.
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls13_signature_with_raw_key};
use rustls::pki_types::{
    CertificateDer, PrivatePkcs8KeyDer, ServerName, SubjectPublicKeyInfoDer, UnixTime, alg_id,
};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::sign::CertifiedKey;
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error, ServerConfig,
    SignatureScheme,
};

use crate::keys::PUBLIC_KEY_LEN;

/// The Ed25519 `SubjectPublicKeyInfo` that a raw public key handshake presents for `key`.
pub(crate) fn spki(key: &[u8; PUBLIC_KEY_LEN]) -> Vec<u8> {
    rustls::sign::public_key_to_spki(&alg_id::ED25519, key)
        .as_ref()
        .to_vec()
}

/// TLS 1.3 client presenting `own_pkcs8` and accepting only a server holding `peer`.
pub(crate) fn client_config(
    own_pkcs8: Vec<u8>,
    peer: &[u8; PUBLIC_KEY_LEN],
) -> Result<ClientConfig, Error> {
    let own = certified(own_pkcs8)?;
    let mut config = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin::new(peer)))
        .with_client_cert_resolver(Arc::new(
            rustls::client::AlwaysResolvesClientRawPublicKeys::new(own),
        ));
    config.resumption = rustls::client::Resumption::disabled();
    config.enable_early_data = false;
    Ok(config)
}

/// TLS 1.3 server presenting `own_pkcs8` and requiring a client holding `peer`.
pub(crate) fn server_config(
    own_pkcs8: Vec<u8>,
    peer: &[u8; PUBLIC_KEY_LEN],
) -> Result<ServerConfig, Error> {
    let own = certified(own_pkcs8)?;
    let mut config = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(Arc::new(Pin::new(peer)))
        .with_cert_resolver(Arc::new(
            rustls::server::AlwaysResolvesServerRawPublicKeys::new(own),
        ));
    config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
    config.send_tls13_tickets = 0;
    config.max_early_data_size = 0;
    Ok(config)
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn certified(pkcs8: Vec<u8>) -> Result<Arc<CertifiedKey>, Error> {
    let key = rustls::crypto::ring::sign::any_eddsa_type(&PrivatePkcs8KeyDer::from(pkcs8))?;
    let spki = key
        .public_key()
        .map(|spki| spki.as_ref().to_vec())
        .ok_or_else(|| Error::General("Ed25519 key without a public key".to_owned()))?;
    Ok(Arc::new(CertifiedKey::new(
        vec![CertificateDer::from(spki)],
        key,
    )))
}

/// Accepts exactly one pinned Ed25519 key, in either handshake role.
#[derive(Debug)]
struct Pin {
    spki: Vec<u8>,
    provider: Arc<CryptoProvider>,
}
impl Pin {
    fn new(peer: &[u8; PUBLIC_KEY_LEN]) -> Self {
        Self {
            spki: spki(peer),
            provider: provider(),
        }
    }
    fn check(
        &self,
        presented: &CertificateDer<'_>,
        others: &[CertificateDer<'_>],
    ) -> Result<(), Error> {
        if others.is_empty() && presented.as_ref() == self.spki.as_slice() {
            Ok(())
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }
    fn tls13(
        &self,
        message: &[u8],
        presented: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.check(presented, &[])?;
        if signature.scheme != SignatureScheme::ED25519 {
            return Err(Error::PeerMisbehaved(
                rustls::PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme,
            ));
        }
        verify_tls13_signature_with_raw_key(
            message,
            &SubjectPublicKeyInfoDer::from(presented.as_ref()),
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }
}
fn tls12_refused() -> Error {
    Error::General("TLS 1.2 is refused".to_owned())
}

impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        self.check(end_entity, intermediates)?;
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(tls12_refused())
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.tls13(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

impl ClientCertVerifier for Pin {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        self.check(end_entity, intermediates)?;
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(tls12_refused())
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.tls13(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}
