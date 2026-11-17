//! Private-CA verifier profiles shared by startup validation and mandatory daemon mutual TLS.
//!
//! Ordinary rustls path/EKU/signature verification remains mandatory. The extra
//! policy narrows credentials to one exact DNS SAN and direct complete issuer CRLs.
//! Unsupported CRL extensions or ambiguous linear paths fail closed. Callers must
//! enforce the returned credential expiry on active links and persist revocation
//! update floors before enabling remote service; this module alone is not C8 completion.
use std::fmt;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{
    CertificateDer, CertificateRevocationListDer, PrivateKeyDer, ServerName, UnixTime,
};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{
    ClientConfig, DigitallySignedStruct, DistinguishedName, RootCertStore, ServerConfig,
    SignatureScheme,
};
use x509_parser::extensions::{GeneralName, ParsedExtension};
use x509_parser::prelude::{FromDer, X509Certificate};
use x509_parser::revocation_list::CertificateRevocationList;

/// Bounded operator-provisioned private roots and complete, direct issuer CRLs.
#[derive(Debug, Clone)]
pub struct Trust {
    roots: Vec<Vec<u8>>,
    crls: Vec<Vec<u8>>,
}
impl Trust {
    /// Parses bounded DER material without loading any system trust store or credential files.
    ///
    /// # Errors
    /// Rejects missing/excessive trust, trailing DER, unsupported CRLs and duplicate issuer CRLs.
    pub fn from_der(roots: Vec<Vec<u8>>, crls: Vec<Vec<u8>>) -> Result<Self, PolicyError> {
        if roots.is_empty()
            || roots.len() > 4
            || crls.is_empty()
            || crls.len() > 16
            || roots.iter().chain(&crls).any(|bytes| bytes.len() > 65_536)
            || roots.iter().chain(&crls).map(Vec::len).sum::<usize>() > 524_288
        {
            return Err(PolicyError);
        }
        for root in &roots {
            let root = certificate(root)?;
            if !root
                .basic_constraints()
                .map_err(|_| PolicyError)?
                .is_some_and(|constraints| constraints.value.ca)
                || !root
                    .key_usage()
                    .map_err(|_| PolicyError)?
                    .is_some_and(|usage| usage.value.key_cert_sign() && usage.value.crl_sign())
            {
                return Err(PolicyError);
            }
        }
        let mut issuers = std::collections::HashSet::new();
        for bytes in &crls {
            let crl = revocations(bytes)?;
            if !issuers.insert(crl.issuer().as_raw().to_vec()) {
                return Err(PolicyError);
            }
        }
        Ok(Self { roots, crls })
    }

    /// Validates every configured CRL before protecting its durable installation floor.
    ///
    /// `issuers` supplies explicit non-trust issuer certificates (typically the own chain).
    /// It cannot add trust anchors or authorize a peer; normal TLS path verification remains
    /// mandatory. Unknown issuers and same-DN different-certificate ambiguity fail closed.
    ///
    /// # Errors
    /// Rejects absent/ambiguous/non-CA/expired issuers, invalid signatures/AKI and stale or
    /// future CRLs, including configured CRLs not applicable to the current own certificate.
    pub fn validate_revocation_bundle(
        &self,
        issuers: &[Vec<u8>],
        now: u64,
    ) -> Result<(), PolicyError> {
        let now = i64::try_from(now).map_err(|_| PolicyError)?;
        let mut material: Vec<&[u8]> = Vec::new();
        for bytes in self.roots.iter().chain(issuers) {
            if !material.contains(&bytes.as_slice()) {
                material.push(bytes);
            }
        }
        let certificates = material
            .into_iter()
            .map(certificate)
            .collect::<Result<Vec<_>, _>>()?;
        for bytes in &self.crls {
            let crl = revocations(bytes)?;
            let candidates: Vec<_> = certificates
                .iter()
                .filter(|cert| cert.subject() == crl.issuer())
                .collect();
            if candidates.len() != 1 {
                return Err(PolicyError);
            }
            let issuer = candidates[0];
            valid_until(issuer, now)?;
            if !issuer
                .basic_constraints()
                .map_err(|_| PolicyError)?
                .is_some_and(|constraints| constraints.value.ca)
                || !issuer
                    .key_usage()
                    .map_err(|_| PolicyError)?
                    .is_some_and(|usage| usage.value.key_cert_sign() && usage.value.crl_sign())
                || crl.last_update().timestamp() > now
                || now >= crl.next_update().ok_or(PolicyError)?.timestamp()
            {
                return Err(PolicyError);
            }
            crl.verify_signature(issuer.public_key())
                .map_err(|_| PolicyError)?;
            check_authority(&crl, issuer)?;
        }
        Ok(())
    }

    pub(crate) fn crls(&self) -> impl Iterator<Item = &[u8]> {
        self.crls.iter().map(Vec::as_slice)
    }

    /// Rejects lower CRL numbers, older issue times and changed data reusing a CRL number.
    ///
    /// This is a validated-update primitive, not persistent anti-rollback storage.
    /// An installer must retain the previous authenticated state across process restarts.
    ///
    /// # Errors
    /// Rejects missing prior issuers and rollback or equivocation for an issuer.
    pub fn check_replacement(&self, replacement: &Self) -> Result<(), PolicyError> {
        for old in &self.crls {
            let prior = revocations(old)?;
            let current = replacement
                .crls
                .iter()
                .find(|bytes| revocations(bytes).is_ok_and(|crl| crl.issuer() == prior.issuer()))
                .ok_or(PolicyError)?;
            let next = revocations(current)?;
            let old_number = prior.crl_number().ok_or(PolicyError)?;
            let new_number = next.crl_number().ok_or(PolicyError)?;
            if new_number < old_number
                || next.last_update() < prior.last_update()
                || (new_number == old_number && old != current)
            {
                return Err(PolicyError);
            }
        }
        Ok(())
    }
}

/// Certificate-policy rejection with no credential contents or private paths in diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyError;
impl fmt::Display for PolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("credential policy rejected")
    }
}
impl std::error::Error for PolicyError {}

/// Exact gateway identity and private trust used by both mandatory mutual-authentication roles.
#[derive(Debug, Clone)]
pub struct Policy {
    trust: Trust,
    dns: String,
}
impl Policy {
    /// Binds one lowercase configured machine ID to its exact gateway DNS SAN.
    ///
    /// # Errors
    /// Rejects malformed machine identifiers; no wildcard, CN or dial-address identity fallback.
    pub fn new(trust: Trust, machine: &str) -> Result<Self, PolicyError> {
        if machine.is_empty()
            || machine.len() > 32
            || !machine.as_bytes()[0].is_ascii_lowercase()
            || !machine
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(PolicyError);
        }
        Ok(Self {
            trust,
            dns: format!("gateway.{machine}.pi.internal"),
        })
    }

    /// Constructs TLS-1.3-only client configuration with mandatory private-CA server verification.
    ///
    /// # Errors
    /// Rejects invalid root/CRL/key material or incompatible client identity credentials.
    pub fn client_config(
        &self,
        chain: Vec<Vec<u8>>,
        key: Vec<u8>,
    ) -> Result<ClientConfig, PolicyError> {
        let roots = self.root_store()?;
        let inner = rustls::client::WebPkiServerVerifier::builder_with_provider(roots, provider())
            .with_crls(self.crl_der())
            .enforce_revocation_expiration()
            .build()
            .map_err(|_| PolicyError)?;
        let mut config = ClientConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| PolicyError)?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(ServerVerifier {
                policy: self.clone(),
                inner,
            }))
            .with_client_auth_cert(
                chain_der(chain)?,
                PrivateKeyDer::try_from(key).map_err(|_| PolicyError)?,
            )
            .map_err(|_| PolicyError)?;
        config.resumption = rustls::client::Resumption::disabled();
        config.enable_early_data = false;
        Ok(config)
    }

    /// Constructs TLS-1.3-only server configuration requiring an exact authorized client SAN.
    ///
    /// # Errors
    /// Rejects invalid private trust, CRLs, key material or server identity credentials.
    pub fn server_config(
        &self,
        chain: Vec<Vec<u8>>,
        key: Vec<u8>,
    ) -> Result<ServerConfig, PolicyError> {
        let inner = rustls::server::WebPkiClientVerifier::builder_with_provider(
            self.root_store()?,
            provider(),
        )
        .with_crls(self.crl_der())
        .enforce_revocation_expiration()
        .build()
        .map_err(|_| PolicyError)?;
        let mut config = ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|_| PolicyError)?
            .with_client_cert_verifier(Arc::new(ClientVerifier {
                policy: self.clone(),
                inner,
            }))
            .with_single_cert(
                chain_der(chain)?,
                PrivateKeyDer::try_from(key).map_err(|_| PolicyError)?,
            )
            .map_err(|_| PolicyError)?;
        config.session_storage = Arc::new(rustls::server::NoServerSessionStorage {});
        config.send_tls13_tickets = 0;
        config.max_early_data_size = 0;
        Ok(config)
    }

    /// Checks exact SAN, complete linear issuer coverage, credential times and full CRL scope.
    ///
    /// Returns the earliest expiry across all configured roots and applicable path/CRLs. It is
    /// an upper bound for an active link, independently capped at 24 hours by its owner.
    /// Even an unused expired/not-yet-valid configured root rejects the policy until
    /// removed. This supplemental check never substitutes for normal rustls path/EKU verification.
    ///
    /// # Errors
    /// Rejects missing/ambiguous issuers, invalid signatures, stale/future CRLs, revoked
    /// serials, unsupported CRL forms and any certificate outside its validity interval.
    pub fn credential_expiry(&self, chain: &[Vec<u8>], now: u64) -> Result<u64, PolicyError> {
        let chain: Vec<_> = chain
            .iter()
            .map(|bytes| CertificateDer::from(bytes.as_slice()))
            .collect();
        self.inspect(&chain, now)
    }

    fn root_store(&self) -> Result<Arc<RootCertStore>, PolicyError> {
        let mut store = RootCertStore::empty();
        for root in &self.trust.roots {
            store
                .add(CertificateDer::from(root.clone()))
                .map_err(|_| PolicyError)?;
        }
        Ok(Arc::new(store))
    }
    fn crl_der(&self) -> Vec<CertificateRevocationListDer<'static>> {
        self.trust
            .crls
            .iter()
            .cloned()
            .map(CertificateRevocationListDer::from)
            .collect()
    }
    fn inspect(&self, chain: &[CertificateDer<'_>], now: u64) -> Result<u64, PolicyError> {
        if chain.is_empty() || chain.len() > 8 {
            return Err(PolicyError);
        }
        let now = i64::try_from(now).map_err(|_| PolicyError)?;
        let certificates: Vec<_> = chain
            .iter()
            .map(|bytes| certificate(bytes.as_ref()))
            .collect::<Result<_, _>>()?;
        let san = certificates[0]
            .subject_alternative_name()
            .map_err(|_| PolicyError)?
            .ok_or(PolicyError)?;
        if san.value.general_names.len() != 1
            || !matches!(&san.value.general_names[0], GeneralName::DNSName(dns) if *dns == self.dns)
        {
            return Err(PolicyError);
        }
        let last = certificates.last().ok_or(PolicyError)?;
        let roots: Vec<_> = self
            .trust
            .roots
            .iter()
            .map(|bytes| certificate(bytes))
            .collect::<Result<_, _>>()?;
        let candidates: Vec<_> = roots
            .iter()
            .filter(|root| root.subject() == last.issuer())
            .collect();
        if candidates.len() != 1 {
            return Err(PolicyError);
        }
        let root = candidates[0];
        // The normal verifier may build a different path through any configured
        // trust anchor. Apply anchor time policy to the entire offered trust set,
        // rather than incorrectly assuming our presented linear chain is its path.
        let mut expiry = roots.iter().try_fold(u64::MAX, |expiry, root| {
            valid_until(root, now).map(|root_expiry| expiry.min(root_expiry))
        })?;
        for (index, cert) in certificates.iter().enumerate() {
            expiry = expiry.min(valid_until(cert, now)?);
            let issuer = certificates.get(index + 1).unwrap_or(root);
            if cert.issuer() != issuer.subject() {
                return Err(PolicyError);
            }
            cert.verify_signature(Some(issuer.public_key()))
                .map_err(|_| PolicyError)?;
            let crl = self
                .trust
                .crls
                .iter()
                .map(|bytes| revocations(bytes))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .find(|crl| crl.issuer() == issuer.subject())
                .ok_or(PolicyError)?;
            let next = crl.next_update().ok_or(PolicyError)?.timestamp();
            if crl.last_update().timestamp() > now || now >= next {
                return Err(PolicyError);
            }
            crl.verify_signature(issuer.public_key())
                .map_err(|_| PolicyError)?;
            check_authority(&crl, issuer)?;
            if crl
                .iter_revoked_certificates()
                .any(|revoked| revoked.raw_serial() == cert.raw_serial())
            {
                return Err(PolicyError);
            }
            expiry = expiry.min(u64::try_from(next).map_err(|_| PolicyError)?);
        }
        Ok(expiry)
    }
    fn handshake_policy(
        &self,
        leaf: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<(), rustls::Error> {
        let mut chain = Vec::with_capacity(intermediates.len() + 1);
        chain.push(leaf.clone());
        chain.extend_from_slice(intermediates);
        self.inspect(&chain, now.as_secs())
            .map(|_| ())
            .map_err(|_| rustls::Error::General("credential policy rejected".to_owned()))
    }
}
fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}
fn chain_der(chain: Vec<Vec<u8>>) -> Result<Vec<CertificateDer<'static>>, PolicyError> {
    if chain.is_empty() || chain.len() > 8 || chain.iter().any(|bytes| bytes.len() > 65_536) {
        return Err(PolicyError);
    }
    Ok(chain.into_iter().map(CertificateDer::from).collect())
}
fn certificate(bytes: &[u8]) -> Result<X509Certificate<'_>, PolicyError> {
    let (remaining, cert) = X509Certificate::from_der(bytes).map_err(|_| PolicyError)?;
    if !remaining.is_empty() || cert.extensions_map().is_err() {
        return Err(PolicyError);
    }
    Ok(cert)
}
fn valid_until(cert: &X509Certificate<'_>, now: i64) -> Result<u64, PolicyError> {
    if cert.validity().not_before.timestamp() > now || now >= cert.validity().not_after.timestamp()
    {
        return Err(PolicyError);
    }
    u64::try_from(cert.validity().not_after.timestamp()).map_err(|_| PolicyError)
}
fn revocations(bytes: &[u8]) -> Result<CertificateRevocationList<'_>, PolicyError> {
    let (remaining, crl) = CertificateRevocationList::from_der(bytes).map_err(|_| PolicyError)?;
    if !remaining.is_empty()
        || crl.crl_number().is_none()
        || crl
            .next_update()
            .is_none_or(|next| next <= crl.last_update())
    {
        return Err(PolicyError);
    }
    crl.tbs_cert_list
        .extensions_map()
        .map_err(|_| PolicyError)?;
    for extension in crl.extensions() {
        if !matches!(
            extension.parsed_extension(),
            ParsedExtension::AuthorityKeyIdentifier(_) | ParsedExtension::CRLNumber(_)
        ) {
            return Err(PolicyError);
        }
    }
    for entry in crl.iter_revoked_certificates() {
        entry.extensions_map().map_err(|_| PolicyError)?;
        for extension in entry.extensions() {
            if !matches!(extension.parsed_extension(), ParsedExtension::ReasonCode(reason) if reason.0 != 8)
                && !matches!(
                    extension.parsed_extension(),
                    ParsedExtension::InvalidityDate(_)
                )
            {
                return Err(PolicyError);
            }
        }
    }
    Ok(crl)
}
fn check_authority(
    crl: &CertificateRevocationList<'_>,
    issuer: &X509Certificate<'_>,
) -> Result<(), PolicyError> {
    let authority = crl
        .extensions()
        .iter()
        .find_map(|extension| match extension.parsed_extension() {
            ParsedExtension::AuthorityKeyIdentifier(authority) => Some(authority),
            _ => None,
        })
        .ok_or(PolicyError)?;
    let subject = issuer
        .extensions()
        .iter()
        .find_map(|extension| match extension.parsed_extension() {
            ParsedExtension::SubjectKeyIdentifier(subject) => Some(subject),
            _ => None,
        })
        .ok_or(PolicyError)?;
    if authority.key_identifier.as_ref() != Some(subject)
        || authority.authority_cert_issuer.is_some()
        || authority.authority_cert_serial.is_some()
    {
        return Err(PolicyError);
    }
    Ok(())
}

#[derive(Debug)]
struct ServerVerifier {
    policy: Policy,
    inner: Arc<rustls::client::WebPkiServerVerifier>,
}
impl ServerCertVerifier for ServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if name.to_str() != self.policy.dns {
            return Err(rustls::Error::General(
                "unexpected configured server identity".to_owned(),
            ));
        }
        self.policy
            .handshake_policy(end_entity, intermediates, now)?;
        self.inner
            .verify_server_cert(end_entity, intermediates, name, ocsp, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}
#[derive(Debug)]
struct ClientVerifier {
    policy: Policy,
    inner: Arc<dyn ClientCertVerifier>,
}
impl ClientCertVerifier for ClientVerifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        self.inner.root_hint_subjects()
    }
    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        self.policy
            .handshake_policy(end_entity, intermediates, now)?;
        self.inner
            .verify_client_cert(end_entity, intermediates, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}
