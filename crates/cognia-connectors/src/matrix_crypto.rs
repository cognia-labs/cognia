use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use matrix_sdk_crypto::types::events::room::encrypted::EncryptedEvent;
use matrix_sdk_crypto::types::requests::AnyOutgoingRequest;
use matrix_sdk_crypto::{
    AttachmentDecryptor, AttachmentEncryptor, DecryptionSettings, EncryptionSettings,
    EncryptionSyncChanges, MediaEncryptionInfo, OlmMachine, OlmMachineBuilder, TrustRequirement,
};
use matrix_sdk_sqlite::SqliteCryptoStore;
use parking_lot::Mutex;
use ruma::api::client::sync::sync_events::DeviceLists;
use ruma::api::{IncomingResponse, IncomingResponseExt};
use ruma::events::{AnyMessageLikeEventContent, AnyToDeviceEvent, MessageLikeEventContent};
use ruma::serde::Raw;
use ruma::{DeviceId, OneTimeKeyAlgorithm, RoomId, TransactionId, UInt, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoInitRequest {
    pub adapter_id: String,
    pub user_id: String,
    pub device_id: String,
    pub store_dir: Option<String>,
    pub store_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoOutgoingRequest {
    pub request_id: String,
    pub kind: String,
    pub method: String,
    pub path: String,
    pub body: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoMarkSentRequest {
    pub adapter_id: String,
    pub request_id: String,
    pub kind: String,
    pub response: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoReceiveSyncRequest {
    pub adapter_id: String,
    #[serde(default)]
    pub to_device_events: Vec<Value>,
    #[serde(default)]
    pub changed_devices: Vec<String>,
    #[serde(default)]
    pub left_devices: Vec<String>,
    #[serde(default)]
    pub one_time_key_counts: HashMap<String, u64>,
    #[serde(default)]
    pub unused_fallback_keys: Vec<String>,
    pub next_batch_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoDecryptRequest {
    pub adapter_id: String,
    pub room_id: String,
    pub event: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoDecryptResponse {
    pub event: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoEncryptRequest {
    pub adapter_id: String,
    pub room_id: String,
    pub event_type: String,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoEncryptResponse {
    pub content: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoShareRoomKeyRequest {
    pub adapter_id: String,
    pub room_id: String,
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoTrackUsersRequest {
    pub adapter_id: String,
    pub user_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoMissingSessionsRequest {
    pub adapter_id: String,
    pub user_ids: Vec<String>,
}

/// Cross-signing exposes public material and trust observations only.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoCrossSigningRequest {
    pub adapter_id: String,
    pub action: String,
    pub server_master_key: Option<String>,
    pub user_id: Option<String>,
    pub device_id: Option<String>,
}

/// Interactive verification is ephemeral; shared QR bytes are never logged.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatrixCryptoVerificationRequest {
    pub adapter_id: String,
    pub action: String,
    pub user_id: String,
    pub device_id: Option<String>,
    pub flow_id: Option<String>,
    pub qr_bytes: Option<Vec<u8>>,
}

type VerificationFlows = HashMap<
    String,
    HashMap<
        (String, String),
        (
            matrix_sdk_crypto::VerificationRequest,
            String,
            std::time::Instant,
        ),
    >,
>;
fn verification_flows() -> &'static Mutex<VerificationFlows> {
    static FLOWS: OnceLock<Mutex<VerificationFlows>> = OnceLock::new();
    FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_verification(
    adapter: &str,
    flow: &matrix_sdk_crypto::VerificationRequest,
    device: Option<&str>,
) -> Result<String, String> {
    let mut cache = verification_flows().lock();
    let flows = cache.entry(adapter.to_owned()).or_default();
    flows.retain(|_, (request, _, used)| {
        !(request.is_done() || request.is_cancelled()) || used.elapsed().as_secs() < 600
    });
    let key = (
        flow.other_user().to_string(),
        flow.flow_id().as_str().to_owned(),
    );
    let observed = flow.other_device_id().map(|id| id.to_string());
    let existing = flows.get(&key).map(|(_, id, _)| id.clone());
    if existing
        .as_ref()
        .zip(observed.as_ref())
        .is_some_and(|(a, b)| a != b)
    {
        return Err("Matrix verification device mismatch".into());
    }
    let id = existing
        .or(observed)
        .or_else(|| device.map(str::to_owned))
        .ok_or("Matrix verification device unavailable")?;
    if !flows.contains_key(&key) && flows.len() >= 128 {
        return Err("Too many Matrix verification flows".into());
    }
    flows.insert(key, (flow.clone(), id.clone(), std::time::Instant::now()));
    Ok(id)
}

pub async fn matrix_crypto_verification(
    req: MatrixCryptoVerificationRequest,
) -> Result<Value, String> {
    use matrix_sdk_crypto::{matrix_sdk_qrcode::QrVerificationData, Verification};
    use ruma::events::key::verification::VerificationMethod;
    let _guard = init_lock().lock().await;
    let machine = get_machine(&req.adapter_id)?;
    let user = UserId::parse(&req.user_id).map_err(|_| "invalid Matrix verification user ID")?;
    if req.action == "list" {
        let mut flows = Vec::new();
        for flow in machine
            .get_verification_requests(&user)
            .into_iter()
            .take(128)
        {
            if !flow.is_done() && !flow.is_cancelled() && !flow.timed_out() {
                if let Some(device) = flow.other_device_id() {
                    let bound =
                        remember_verification(&req.adapter_id, &flow, Some(device.as_str()))?;
                    flows.push(verification_snapshot(&machine, &flow, &bound).await?);
                }
            }
        }
        return Ok(json!({"flows": flows}));
    }
    let methods = || {
        vec![
            VerificationMethod::SasV1,
            VerificationMethod::QrCodeShowV1,
            VerificationMethod::QrCodeScanV1,
            VerificationMethod::ReciprocateV1,
        ]
    };
    let mut requests = Vec::new();
    let mut qr_bytes = None;
    let mut qr_image = None;
    let flow = if req.action == "request" {
        {
            let mut cache = verification_flows().lock();
            let flows = cache.entry(req.adapter_id.clone()).or_default();
            flows.retain(|_, (flow, _, used)| {
                !flow.timed_out()
                    && (!(flow.is_done() || flow.is_cancelled()) || used.elapsed().as_secs() < 600)
            });
            if flows.len() >= 128 {
                return Err("Too many Matrix verification flows".into());
            }
        }
        let device_id: &DeviceId = req
            .device_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or("Matrix verification device ID required")?
            .into();
        let device = machine
            .get_device(&user, device_id, None)
            .await
            .map_err(|_| "Matrix verification device unavailable")?
            .ok_or("Matrix verification device unavailable")?;
        let (flow, outgoing) = device.request_verification_with_methods(methods());
        remember_verification(&req.adapter_id, &flow, req.device_id.as_deref())?;
        requests.push(outgoing);
        flow
    } else {
        let flow_id = req
            .flow_id
            .as_deref()
            .filter(|id| id.len() <= 1024)
            .ok_or("Matrix verification flow ID required")?;
        let flow = machine
            .get_verification_request(&user, flow_id)
            .or_else(|| {
                verification_flows()
                    .lock()
                    .get(&req.adapter_id)
                    .and_then(|flows| flows.get(&(user.to_string(), flow_id.to_owned())))
                    .map(|(flow, _, _)| flow.clone())
            })
            .ok_or("Matrix verification flow unavailable")?;
        let bound_device = remember_verification(&req.adapter_id, &flow, None)?;
        if let Some(device_id) = req.device_id.as_deref() {
            if bound_device != device_id {
                return Err("Matrix verification device mismatch".into());
            }
        }
        if req.action != "status" && (flow.is_cancelled() || flow.is_done() || flow.timed_out()) {
            return Err("Matrix verification flow is terminal".into());
        }
        match req.action.as_str() {
            "status" => {}
            "accept" => requests.extend(flow.accept_with_methods(methods())),
            "startSas" => {
                let (_, outgoing) = flow
                    .start_sas()
                    .await
                    .map_err(|_| "Matrix SAS start failed")?
                    .ok_or("Matrix verification is not ready for SAS")?;
                requests.push(outgoing);
            }
            "generateQr" => {
                let qr = flow
                    .generate_qr_code()
                    .await
                    .map_err(|_| "Matrix QR generation failed")?
                    .ok_or("Matrix verification is not ready for QR")?;
                qr_bytes = Some(qr.to_bytes().map_err(|_| "Matrix QR encoding failed")?);
                let code = qr
                    .to_qr_code()
                    .map_err(|_| "Matrix QR image encoding failed")?;
                qr_image = Some(
                    json!({"size": code.width(), "modules": code.to_colors().into_iter().map(|color| color.select(true, false)).collect::<Vec<_>>()}),
                );
            }
            "scanQr" => {
                let bytes = req
                    .qr_bytes
                    .as_deref()
                    .filter(|bytes| bytes.len() <= 4096)
                    .ok_or("Matrix QR bytes required or oversized")?;
                let data =
                    QrVerificationData::from_bytes(bytes).map_err(|_| "Invalid Matrix QR data")?;
                let qr = flow
                    .scan_qr_code(data)
                    .await
                    .map_err(|_| "Matrix QR key or flow mismatch")?
                    .ok_or("Matrix verification is not ready for QR scan")?;
                requests.extend(qr.reciprocate());
            }
            "acceptSas" | "confirmSas" | "confirmQr" => {
                let verification = machine
                    .get_verification(&user, flow_id)
                    .ok_or("Matrix verification method unavailable")?;
                match (req.action.as_str(), verification) {
                    ("acceptSas", Verification::SasV1(sas)) => requests.extend(sas.accept()),
                    ("confirmSas", Verification::SasV1(sas)) => {
                        if !sas.can_be_presented() {
                            return Err("Matrix SAS cannot be confirmed before comparison".into());
                        }
                        let (outgoing, signatures) = sas
                            .confirm()
                            .await
                            .map_err(|_| "Matrix SAS confirmation failed")?;
                        requests.extend(outgoing);
                        if let Some(signatures) = signatures {
                            let descriptor = outgoing_request_to_descriptor(
                                uuid::Uuid::new_v4().to_string(),
                                &AnyOutgoingRequest::SignatureUpload(signatures),
                            )?;
                            // Signature uploads are returned with the other SDK requests below.
                            let mut response =
                                verification_snapshot(&machine, &flow, &bound_device).await?;
                            let mut descriptors = verification_descriptors(requests)?;
                            descriptors.push(descriptor);
                            response["requests"] = serde_json::to_value(descriptors)
                                .map_err(|_| "Matrix verification serialization failed")?;
                            return Ok(response);
                        }
                    }
                    ("confirmQr", Verification::QrV1(qr)) => {
                        if !qr.has_been_scanned() {
                            return Err("Matrix QR has not been scanned".into());
                        }
                        requests.extend(qr.confirm_scanning());
                    }
                    _ => return Err("Matrix verification method mismatch".into()),
                }
            }
            "cancel" => requests.extend(flow.cancel()),
            _ => return Err("unsupported Matrix verification action".into()),
        }
        flow
    };
    let bound_device = remember_verification(&req.adapter_id, &flow, req.device_id.as_deref())?;
    let mut response = verification_snapshot(&machine, &flow, &bound_device).await?;
    response["requests"] = serde_json::to_value(verification_descriptors(requests)?)
        .map_err(|_| "Matrix verification serialization failed")?;
    if let Some(bytes) = qr_bytes {
        response["qrBytes"] = json!(bytes);
    }
    if let Some(image) = qr_image {
        response["qrImage"] = image;
    }
    Ok(response)
}

fn verification_descriptors(
    requests: Vec<matrix_sdk_crypto::types::requests::OutgoingVerificationRequest>,
) -> Result<Vec<MatrixCryptoOutgoingRequest>, String> {
    requests
        .into_iter()
        .map(|request| {
            let id = request.request_id().to_string();
            outgoing_request_to_descriptor(id, &request.into())
        })
        .collect()
}

async fn verification_snapshot(
    machine: &OlmMachine,
    flow: &matrix_sdk_crypto::VerificationRequest,
    device_id: &str,
) -> Result<Value, String> {
    use matrix_sdk_crypto::Verification;
    let device = machine
        .get_device(flow.other_user(), device_id.into(), None)
        .await
        .map_err(|_| "Matrix verification trust unavailable")?;
    let mut result = json!({"flowId": flow.flow_id().as_str(), "userId": flow.other_user(), "deviceId": device_id, "state": if flow.is_done() { "done" } else if flow.is_cancelled() || flow.timed_out() { "cancelled" } else if flow.is_ready() { "ready" } else { "requested" }, "deviceVerified": device.is_some_and(|d| d.is_verified()), "requests": []});
    if let Some(verification) = machine.get_verification(flow.other_user(), flow.flow_id().as_str())
    {
        match verification {
            Verification::SasV1(sas) => {
                if !sas.is_done() && !sas.is_cancelled() {
                    result["state"] = json!("sas");
                }
                result["decimals"] = json!(sas.decimals().map(|(a, b, c)| [a, b, c]));
                result["emojiIndices"] = json!(sas.emoji_index());
                result["confirmed"] = json!(sas.have_we_confirmed());
                result["sasStartedByUs"] = json!(sas.we_started());
            }
            Verification::QrV1(qr) => {
                if !qr.is_done() && !qr.is_cancelled() {
                    result["state"] = json!("qr");
                }
                result["scanned"] = json!(qr.has_been_scanned());
                result["confirmed"] = json!(qr.has_been_confirmed());
            }
            _ => return Err("Unsupported Matrix verification method".into()),
        }
    }
    Ok(result)
}

fn cross_signing_public_key(identity: &matrix_sdk_crypto::UserIdentity) -> Option<String> {
    let key = match identity {
        matrix_sdk_crypto::UserIdentity::Own(identity) => identity.master_key(),
        matrix_sdk_crypto::UserIdentity::Other(identity) => identity.master_key(),
    };
    key.get_first_key().map(|key| key.to_base64())
}

pub async fn matrix_crypto_cross_signing(
    req: MatrixCryptoCrossSigningRequest,
) -> Result<Value, String> {
    let _guard = init_lock().lock().await;
    let machine = get_machine(&req.adapter_id)?;
    let private = machine.cross_signing_status().await;
    if req.action == "prepare" {
        let current = machine
            .get_identity(machine.user_id(), None)
            .await
            .map_err(|_| "Matrix cross-signing identity unavailable")?;
        let public = current.as_ref().and_then(cross_signing_public_key);
        // Bootstrap(false) can generate fresh keys when only someone else's
        // public identity is cached. Never silently replace that identity.
        if current.is_some()
            && !(private.has_master && private.has_self_signing && private.has_user_signing)
        {
            return Err("Existing Matrix cross-signing identity requires its private keys".into());
        }
        if req.server_master_key.is_some() && req.server_master_key != public {
            return Err("Matrix cross-signing server identity mismatch".into());
        }
        let bootstrap = machine
            .bootstrap_cross_signing(false)
            .await
            .map_err(|_| "Matrix cross-signing preparation failed")?;
        let mut requests = Vec::new();
        if let Some(request) = bootstrap.upload_keys_req {
            requests.push(outgoing_request_to_descriptor(
                request.request_id().to_string(),
                request.request(),
            )?);
        }
        let signing = bootstrap.upload_signing_keys_req;
        requests.push(MatrixCryptoOutgoingRequest {
            request_id: uuid::Uuid::new_v4().to_string(), kind: "signingKeysUpload".into(),
            method: "POST".into(), path: "/_matrix/client/v3/keys/device_signing/upload".into(),
            body: json!({"master_key": signing.master_key, "self_signing_key": signing.self_signing_key, "user_signing_key": signing.user_signing_key}),
        });
        requests.push(MatrixCryptoOutgoingRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            kind: "signatureUpload".into(),
            method: "POST".into(),
            path: "/_matrix/client/v3/keys/signatures/upload".into(),
            body: serde_json::to_value(bootstrap.upload_signatures_req.signed_keys)
                .map_err(|_| "Matrix cross-signing public signature serialization failed")?,
        });
        return Ok(json!({"requests": requests}));
    }
    if req.action != "status" {
        return Err("unsupported Matrix cross-signing action".into());
    }
    let user = req
        .user_id
        .as_deref()
        .map(UserId::parse)
        .transpose()
        .map_err(|_| "invalid Matrix cross-signing user ID")?
        .unwrap_or_else(|| machine.user_id().to_owned());
    let device_id: &DeviceId = req
        .device_id
        .as_deref()
        .unwrap_or(machine.device_id().as_str())
        .into();
    let identity = machine
        .get_identity(&user, None)
        .await
        .map_err(|_| "Matrix cross-signing identity unavailable")?;
    let device = machine
        .get_device(&user, device_id, None)
        .await
        .map_err(|_| "Matrix cross-signing device unavailable")?;
    Ok(json!({
        "hasMaster": private.has_master, "hasSelfSigning": private.has_self_signing,
        "hasUserSigning": private.has_user_signing,
        "masterKey": identity.as_ref().and_then(cross_signing_public_key),
        "identityVerified": identity.as_ref().is_some_and(|identity| identity.is_verified()),
        "deviceCrossSigned": device.as_ref().is_some_and(|device| device.is_cross_signed_by_owner()),
        "deviceTrusted": device.as_ref().is_some_and(|device| device.is_cross_signing_trusted()),
    }))
}

/// Recovery material is never Debug-formatted or placed in error messages.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatrixCryptoBackupRequest {
    pub adapter_id: String,
    pub action: String,
    pub version: Option<String>,
    pub backup_info: Option<Value>,
    pub recovery_key: Option<String>,
    pub create_claim: Option<String>,
    pub rooms: Option<Value>,
}

#[derive(Serialize, Deserialize)]
struct MatrixBackupCreateIntent {
    claim: String,
    user_id: String,
    device_id: String,
    public_key: String,
}

fn backup_create_intent(adapter_id: &str) -> Result<Option<MatrixBackupCreateIntent>, String> {
    super::keyring::get(adapter_id, "matrix-backup-create-intent")?
        .map(|raw| {
            serde_json::from_str(&raw)
                .map_err(|_| "Matrix backup create intent is unreadable".to_string())
        })
        .transpose()
}

fn check_backup_intent(
    intent: &MatrixBackupCreateIntent,
    machine: &OlmMachine,
    public_key: &str,
) -> Result<(), String> {
    if intent.user_id != machine.user_id().as_str()
        || intent.device_id != machine.device_id().as_str()
        || intent.public_key != public_key
    {
        return Err(
            "Unresolved Matrix backup creation must be reconciled before replacing its key".into(),
        );
    }
    Ok(())
}

pub async fn matrix_crypto_backup(req: MatrixCryptoBackupRequest) -> Result<Value, String> {
    use matrix_sdk_crypto::{
        olm::{ExportedRoomKey, InboundGroupSession},
        store::types::BackupDecryptionKey,
        types::RoomKeyBackupInfo,
    };
    // No network awaits: serialize with init/close and other backup mutations.
    let _guard = init_lock().lock().await;
    if req.action == "cancelCreate" {
        let claim = req
            .create_claim
            .as_deref()
            .filter(|value| uuid::Uuid::parse_str(value).is_ok())
            .ok_or("Matrix backup creation claim is required")?;
        if let Some(intent) = backup_create_intent(&req.adapter_id)? {
            if intent.claim != claim {
                return Err("Matrix backup creation claim mismatch".into());
            }
            super::keyring::delete(&req.adapter_id, "matrix-backup-create-intent")?;
        }
        return Ok(json!({"cancelled": true}));
    }
    let machine = get_machine(&req.adapter_id)?;
    let backup = machine.backup_machine();
    match req.action.as_str() {
        "prepare" => {
            let stored = backup
                .get_backup_keys()
                .await
                .map_err(|_| "Matrix backup store unavailable")?;
            let pending = backup_create_intent(&req.adapter_id)?;
            if pending.is_some() && stored.decryption_key.is_none() {
                return Err(
                    "Unresolved Matrix backup creation belongs to another store identity".into(),
                );
            }
            let key = match stored.decryption_key {
                Some(key) => key,
                None => {
                    let mut bytes = [0u8; 32];
                    rand::fill(&mut bytes);
                    let key = BackupDecryptionKey::from_bytes(&bytes);
                    backup
                        .save_decryption_key(Some(key.clone()), None)
                        .await
                        .map_err(|_| "Matrix backup key persistence failed")?;
                    key
                }
            };
            if let Some(intent) = &pending {
                check_backup_intent(intent, &machine, &key.megolm_v1_public_key().to_base64())?;
            }
            let mut info = key.to_backup_info();
            backup
                .sign_backup(&mut info)
                .await
                .map_err(|_| "Matrix backup signing failed")?;
            Ok(
                json!({"recoveryKey": key.to_base58(), "backupInfo": info, "version": stored.backup_version, "createPending": super::keyring::get(&req.adapter_id, "matrix-backup-create-intent")?.is_some()}),
            )
        }
        "beginCreate" => {
            let key = backup
                .get_backup_keys()
                .await
                .map_err(|_| "Matrix backup store unavailable")?
                .decryption_key
                .ok_or("Matrix backup must be prepared first")?;
            let info: RoomKeyBackupInfo = serde_json::from_value(
                req.backup_info
                    .ok_or("Matrix prepared backup metadata is required")?,
            )
            .map_err(|_| "invalid Matrix backup metadata")?;
            if !key.backup_key_matches(&info) {
                return Err("Matrix prepared backup key changed".into());
            }
            let claim = req
                .create_claim
                .filter(|value| uuid::Uuid::parse_str(value).is_ok())
                .ok_or("Matrix backup creation claim is required")?;
            if let Some(intent) = backup_create_intent(&req.adapter_id)? {
                check_backup_intent(&intent, &machine, &key.megolm_v1_public_key().to_base64())?;
                if intent.claim == claim {
                    return Ok(json!({"createPending": true, "createClaim": claim}));
                }
                return Err("Matrix backup creation outcome is unknown; reconcile first".into());
            }
            let intent = MatrixBackupCreateIntent {
                claim,
                user_id: machine.user_id().to_string(),
                device_id: machine.device_id().to_string(),
                public_key: key.megolm_v1_public_key().to_base64(),
            };
            super::keyring::set(
                &req.adapter_id,
                "matrix-backup-create-intent",
                &serde_json::to_string(&intent)
                    .map_err(|_| "Matrix backup intent persistence failed")?,
            )?;
            Ok(json!({"createPending": true, "createClaim": intent.claim}))
        }
        "enable" | "restore" => {
            let version = req
                .version
                .as_deref()
                .filter(|v| !v.trim().is_empty() && v.len() <= 256)
                .ok_or("Matrix backup version is required")?;
            let info_value = req
                .backup_info
                .ok_or("Matrix backup metadata is required")?;
            if info_value.get("version").and_then(Value::as_str) != Some(version) {
                return Err("Matrix backup version mismatch".into());
            }
            let info: RoomKeyBackupInfo =
                serde_json::from_value(info_value).map_err(|_| "invalid Matrix backup metadata")?;
            let key = if req.action == "restore" {
                BackupDecryptionKey::from_base58(
                    req.recovery_key
                        .as_deref()
                        .ok_or("Matrix recovery key is required")?,
                )
                .map_err(|_| "invalid Matrix recovery key")?
            } else {
                backup
                    .get_backup_keys()
                    .await
                    .map_err(|_| "Matrix backup store unavailable")?
                    .decryption_key
                    .ok_or("Matrix backup must be prepared first")?
            };
            if !key.backup_key_matches(&info) {
                return Err("Matrix backup public key mismatch".into());
            }
            if let Some(intent) = backup_create_intent(&req.adapter_id)? {
                check_backup_intent(&intent, &machine, &key.megolm_v1_public_key().to_base64())?;
            }
            let mut imported = 0;
            let mut total = 0;
            if req.action == "restore" {
                let rooms = req.rooms.ok_or("Matrix backup rooms are required")?;
                if serde_json::to_vec(&rooms)
                    .map_err(|_| "invalid Matrix backup")?
                    .len()
                    > 8 * 1024 * 1024
                {
                    return Err("Matrix backup exceeds restore budget".into());
                }
                let mut exported = Vec::new();
                for (room_id, room) in rooms.as_object().ok_or("invalid Matrix backup rooms")? {
                    let room_id = RoomId::parse(room_id).map_err(|_| "invalid backup room ID")?;
                    for (session_id, session) in room
                        .get("sessions")
                        .and_then(Value::as_object)
                        .ok_or("invalid Matrix backup sessions")?
                    {
                        if exported.len() >= 500 {
                            return Err("Matrix backup exceeds session budget".into());
                        }
                        let data = serde_json::from_value(
                            session
                                .get("session_data")
                                .cloned()
                                .ok_or("missing backup session data")?,
                        )
                        .map_err(|_| "invalid backup session data")?;
                        let decrypted = key
                            .decrypt_session_data(data)
                            .map_err(|_| "Matrix backup session decryption failed")?;
                        let room_key = ExportedRoomKey::from_backed_up_room_key(
                            room_id.clone(),
                            session_id.clone(),
                            decrypted,
                        );
                        let checked = InboundGroupSession::try_from(&room_key)
                            .map_err(|_| "invalid Matrix backup session key")?;
                        let actual = vodozemac::megolm::InboundGroupSession::import(
                            &room_key.session_key,
                            vodozemac::megolm::SessionConfig::version_1(),
                        );
                        if checked.session_id() != actual.session_id()
                            || actual.session_id() != *session_id
                        {
                            return Err("Matrix backup session identity mismatch".into());
                        }
                        exported.push(room_key);
                    }
                }
                if exported.is_empty() {
                    return Err("Matrix backup contains no sessions".into());
                }
                // Authenticate the entire batch before importing any key.
                let result = machine
                    .store()
                    .import_room_keys(exported, Some(version), |_, _| {})
                    .await
                    .map_err(|_| "Matrix backup import failed")?;
                imported = result.imported_count;
                total = result.total_count;
            }
            backup
                .save_decryption_key(Some(key.clone()), Some(version.to_string()))
                .await
                .map_err(|_| "Matrix backup key persistence failed")?;
            let public = key.megolm_v1_public_key();
            public.set_version(version.to_string());
            backup
                .enable_backup_v1(public)
                .await
                .map_err(|_| "Matrix backup activation failed")?;
            super::keyring::delete(&req.adapter_id, "matrix-backup-create-intent")?;
            Ok(json!({"version": version, "enabled": true, "imported": imported, "total": total}))
        }
        "status" => {
            let count = backup
                .room_key_counts()
                .await
                .map_err(|_| "Matrix backup status failed")?;
            Ok(
                json!({"enabled": backup.enabled().await, "version": backup.backup_version().await, "total": count.total, "backedUp": count.backed_up}),
            )
        }
        _ => Err("unsupported Matrix backup action".into()),
    }
}

#[derive(Clone)]
struct MatrixCryptoSession {
    user_id: String,
    device_id: String,
    machine: OlmMachine,
}

static SESSIONS: OnceLock<Arc<Mutex<HashMap<String, MatrixCryptoSession>>>> = OnceLock::new();

fn sessions() -> &'static Arc<Mutex<HashMap<String, MatrixCryptoSession>>> {
    SESSIONS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

/// Serializes `matrix_crypto_init` calls. Inits happen once per adapter at boot,
/// so a single global async gate is cheap, and holding it across the
/// store-open/OlmMachine-build await closes the check-then-insert TOCTOU: a
/// concurrent double-invoke for the same adapter can no longer both open the
/// crypto store and race the final insert (last-write-wins device identity).
static INIT_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn init_lock() -> &'static tokio::sync::Mutex<()> {
    INIT_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[cfg(test)]
pub(crate) fn matrix_crypto_reset_for_test(adapter_id: &str) {
    // Remove ONLY the named adapter, not the whole process-global map — the
    // crypto tests run in parallel and share `SESSIONS`, so a wholesale clear
    // would wipe a sibling test's just-initialized session mid-run.
    sessions().lock().remove(adapter_id);
}

/// Passphrase used to encrypt the on-disk SqliteCryptoStore. The Olm device and
/// Megolm session keys must never be persisted in plaintext, so when the caller
/// doesn't supply one we derive a stable per-adapter+device passphrase from the
/// OS keyring (get-or-create a random secret), mirroring the attachment
/// master-key pattern.
fn crypto_store_passphrase(adapter_id: &str, device_id: &str) -> Result<String, String> {
    let account = format!("matrix-crypto-store-passphrase:{device_id}");
    if let Some(existing) = super::keyring::get(adapter_id, &account)? {
        return Ok(existing);
    }
    let mut raw = [0u8; 32];
    rand::fill(&mut raw);
    let passphrase = hex::encode(raw);
    super::keyring::set(adapter_id, &account, &passphrase)?;
    Ok(passphrase)
}

/// Sanitize a Matrix device id into a single safe path segment.
fn device_path_segment(device_id: &str) -> String {
    let seg: String = device_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if seg.is_empty() {
        "_".to_string()
    } else {
        seg
    }
}

fn default_store_dir(adapter_id: &str, device_id: &str) -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("cognia")
        .join("connectors")
        .join("matrix")
        .join(adapter_id)
        // Scope by device so a token/device rotation opens a FRESH store instead
        // of loading the previous device's account (which the server no longer
        // recognizes → encrypt/decrypt breaks after restart).
        .join(device_path_segment(device_id))
        .join("crypto-store")
}

fn get_machine(adapter_id: &str) -> Result<OlmMachine, String> {
    sessions()
        .lock()
        .get(adapter_id)
        .map(|session| session.machine.clone())
        .ok_or_else(|| format!("Matrix crypto session is not initialized for adapter {adapter_id}"))
}

pub async fn matrix_crypto_init(req: MatrixCryptoInitRequest) -> Result<(), String> {
    if req.adapter_id.trim().is_empty() {
        return Err("adapterId is required".to_string());
    }
    if req.device_id.trim().is_empty() {
        return Err("deviceId is required".to_string());
    }
    let user_id = UserId::parse(&req.user_id).map_err(|err| format!("invalid userId: {err}"))?;
    let device_id: &DeviceId = req.device_id.as_str().into();

    // Serialize inits (see INIT_LOCK) so the existence check below and the final
    // insert are atomic w.r.t. any concurrent init for the same adapter.
    let _init_guard = init_lock().lock().await;

    {
        let guard = sessions().lock();
        if let Some(existing) = guard.get(&req.adapter_id) {
            if existing.user_id != req.user_id || existing.device_id != req.device_id {
                return Err(format!(
                    "adapter {} already has a different Matrix identity",
                    req.adapter_id
                ));
            }
            return Ok(());
        }
    }

    let machine = if cfg!(test) && req.store_dir.is_none() {
        OlmMachine::new(&user_id, device_id).await
    } else {
        let store_dir = req
            .store_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_store_dir(&req.adapter_id, &req.device_id));
        // Never persist the crypto store in plaintext: use the caller's
        // passphrase when provided, else a stable keyring-derived one.
        let passphrase = match req.store_passphrase.as_deref() {
            Some(p) if !p.is_empty() => p.to_string(),
            _ => crypto_store_passphrase(&req.adapter_id, &req.device_id)?,
        };
        let store = SqliteCryptoStore::open(store_dir, Some(passphrase.as_str()))
            .await
            .map_err(|err| format!("open Matrix crypto store failed: {err}"))?;
        OlmMachineBuilder::new(&user_id, device_id)
            .with_crypto_store(store)
            .build()
            .await
            .map_err(|err| format!("open Matrix OlmMachine failed: {err}"))?
    };

    sessions().lock().insert(
        req.adapter_id,
        MatrixCryptoSession {
            user_id: req.user_id,
            device_id: req.device_id,
            machine,
        },
    );
    Ok(())
}

/// Drop only the process-local machine for one adapter. The encrypted SQLite
/// store remains on disk, so a clean stop or device rotation can re-open the
/// same account without retaining a stale in-memory identity.
pub async fn matrix_crypto_close(adapter_id: &str) -> Result<(), String> {
    if adapter_id.trim().is_empty() {
        return Err("adapterId is required".to_string());
    }
    // Serialize with init so a close racing an in-flight store open cannot
    // return first and then have the stale machine inserted afterwards.
    let _init_guard = init_lock().lock().await;
    verification_flows().lock().remove(adapter_id);
    sessions().lock().remove(adapter_id);
    Ok(())
}

pub async fn matrix_crypto_outgoing_requests(
    adapter_id: String,
) -> Result<Vec<MatrixCryptoOutgoingRequest>, String> {
    let machine = get_machine(&adapter_id)?;
    let mut requests = machine
        .outgoing_requests()
        .await
        .map_err(|err| format!("Matrix outgoing requests failed: {err}"))?
        .into_iter()
        .map(|req| outgoing_request_to_descriptor(req.request_id().to_string(), req.request()))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some((id, request)) = machine
        .backup_machine()
        .backup()
        .await
        .map_err(|_| "Matrix backup batch failed")?
    {
        requests.push(descriptor(
            id.to_string(),
            "keysBackup",
            "PUT",
            &format!(
                "/_matrix/client/v3/room_keys/keys?version={}",
                encode_path_segment(&request.version)
            ),
            Ok(json!({"rooms": request.rooms})),
        )?);
    }
    Ok(requests)
}

pub async fn matrix_crypto_update_tracked_users(
    req: MatrixCryptoTrackUsersRequest,
) -> Result<(), String> {
    let machine = get_machine(&req.adapter_id)?;
    let users = parse_user_ids(&req.user_ids)?;
    // Collect before awaiting: a `map(|u| u.as_ref())` closure held across the
    // await tickles rustc's "FnOnce is not general enough" HRTB bug inside the
    // tauri::command expansion.
    let user_refs: Vec<&UserId> = users.iter().map(AsRef::as_ref).collect();
    machine
        .update_tracked_users(user_refs)
        .await
        .map_err(|err| format!("Matrix update tracked users failed: {err}"))
}

pub async fn matrix_crypto_get_missing_sessions(
    req: MatrixCryptoMissingSessionsRequest,
) -> Result<Vec<MatrixCryptoOutgoingRequest>, String> {
    let machine = get_machine(&req.adapter_id)?;
    let users = parse_user_ids(&req.user_ids)?;
    let user_refs: Vec<&UserId> = users.iter().map(AsRef::as_ref).collect();
    let Some((request_id, request)) = machine
        .get_missing_sessions(user_refs.into_iter())
        .await
        .map_err(|err| format!("Matrix missing sessions failed: {err}"))?
    else {
        return Ok(Vec::new());
    };

    let request = AnyOutgoingRequest::KeysClaim(request);
    Ok(vec![outgoing_request_to_descriptor(
        request_id.to_string(),
        &request,
    )?])
}

pub async fn matrix_crypto_share_room_key(
    req: MatrixCryptoShareRoomKeyRequest,
) -> Result<Vec<MatrixCryptoOutgoingRequest>, String> {
    let machine = get_machine(&req.adapter_id)?;
    let room_id = RoomId::parse(&req.room_id).map_err(|err| format!("invalid roomId: {err}"))?;
    let users = parse_user_ids(&req.user_ids)?;
    let user_refs: Vec<&UserId> = users.iter().map(AsRef::as_ref).collect();
    let requests = machine
        .share_room_key(
            &room_id,
            user_refs.into_iter(),
            EncryptionSettings::default(),
        )
        .await
        .map_err(|err| format!("Matrix share room key failed: {err}"))?;

    requests
        .into_iter()
        .map(|req| {
            let any = AnyOutgoingRequest::ToDeviceRequest((*req).clone());
            outgoing_request_to_descriptor(req.txn_id.to_string(), &any)
        })
        .collect()
}

pub async fn matrix_crypto_receive_sync_changes(
    req: MatrixCryptoReceiveSyncRequest,
) -> Result<(), String> {
    let machine = get_machine(&req.adapter_id)?;
    let to_device_events = req
        .to_device_events
        .into_iter()
        .map(raw_from_value::<AnyToDeviceEvent>)
        .collect::<Result<Vec<_>, _>>()?;
    let mut changed_devices = DeviceLists::new();
    changed_devices.changed = parse_user_ids(&req.changed_devices)?;
    changed_devices.left = parse_user_ids(&req.left_devices)?;
    let one_time_key_counts = parse_otk_counts(req.one_time_key_counts)?;
    let unused_fallback_keys = parse_otk_algorithms(req.unused_fallback_keys)?;
    let changes = EncryptionSyncChanges {
        to_device_events,
        changed_devices: &changed_devices,
        one_time_keys_counts: &one_time_key_counts,
        unused_fallback_keys: Some(&unused_fallback_keys),
        next_batch_token: req.next_batch_token,
    };

    machine
        .receive_sync_changes(changes, &untrusted_decryption_settings())
        .await
        .map(|_| ())
        .map_err(|err| format!("Matrix receive sync changes failed: {err}"))
}

pub async fn matrix_crypto_decrypt_event(
    req: MatrixCryptoDecryptRequest,
) -> Result<MatrixCryptoDecryptResponse, String> {
    let machine = get_machine(&req.adapter_id)?;
    let room_id = RoomId::parse(&req.room_id).map_err(|err| format!("invalid roomId: {err}"))?;
    let event = raw_from_value::<EncryptedEvent>(req.event)?;
    let decrypted = machine
        .decrypt_room_event(&event, &room_id, &untrusted_decryption_settings())
        .await
        .map_err(|err| format!("Matrix decrypt room event failed: {err}"))?;
    let event = serde_json::to_value(decrypted)
        .map_err(|err| format!("serialize Matrix decrypted event failed: {err}"))?;
    Ok(MatrixCryptoDecryptResponse { event })
}

pub async fn matrix_crypto_encrypt_event(
    req: MatrixCryptoEncryptRequest,
) -> Result<MatrixCryptoEncryptResponse, String> {
    let machine = get_machine(&req.adapter_id)?;
    let room_id = RoomId::parse(&req.room_id).map_err(|err| format!("invalid roomId: {err}"))?;
    let raw = raw_from_value::<AnyMessageLikeEventContent>(req.content)?;
    let encrypted = machine
        .encrypt_room_event_raw(&room_id, &req.event_type, &raw)
        .await
        .map_err(|err| format!("Matrix encrypt room event failed: {err}"))?;
    let content = serde_json::to_value(&encrypted.content)
        .map_err(|err| format!("serialize Matrix encrypted content failed: {err}"))?;
    Ok(MatrixCryptoEncryptResponse { content })
}

pub async fn matrix_crypto_mark_request_sent(
    req: MatrixCryptoMarkSentRequest,
) -> Result<(), String> {
    let machine = get_machine(&req.adapter_id)?;
    let txn_id: &TransactionId = req.request_id.as_str().into();

    match req.kind.as_str() {
        "signingKeysUpload" => {
            let response: ruma::api::client::keys::upload_signing_keys::v3::Response =
                parse_matrix_response(req.response, "signing-keys-upload")?;
            machine
                .mark_request_as_sent(
                    txn_id,
                    matrix_sdk_crypto::types::requests::AnyIncomingResponse::SigningKeysUpload(
                        &response,
                    ),
                )
                .await
                .map_err(|_| "Matrix signing-keys upload ACK failed".to_string())
        }
        "keysBackup" => {
            let response: ruma::api::client::backup::add_backup_keys::v3::Response =
                parse_matrix_response(req.response, "keys-backup")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|_| "Matrix backup ACK failed".to_string())
        }
        "toDevice" => {
            let response = ruma::api::client::to_device::send_event_to_device::v3::Response::new();
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark to-device sent failed: {err}"))
        }
        "roomMessage" => {
            let response: ruma::api::client::message::send_message_event::v3::Response =
                parse_matrix_response(req.response, "room-message")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark room-message sent failed: {err}"))
        }
        "keysUpload" => {
            let response: ruma::api::client::keys::upload_keys::v3::Response =
                parse_matrix_response(req.response, "keys-upload")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark keys-upload sent failed: {err}"))
        }
        "keysQuery" => {
            let response: ruma::api::client::keys::get_keys::v3::Response =
                parse_matrix_response(req.response, "keys-query")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark keys-query sent failed: {err}"))
        }
        "keysClaim" => {
            let response: ruma::api::client::keys::claim_keys::v3::Response =
                parse_matrix_response(req.response, "keys-claim")?;
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark keys-claim sent failed: {err}"))
        }
        "signatureUpload" => {
            let response: ruma::api::client::keys::upload_signatures::v3::Response =
                parse_matrix_response(req.response, "signature-upload")?;
            if !response.failures.is_empty() {
                return Err("Matrix signature upload was rejected".into());
            }
            machine
                .mark_request_as_sent(txn_id, &response)
                .await
                .map_err(|err| format!("Matrix mark signature-upload sent failed: {err}"))
        }
        other => Err(format!("unsupported Matrix crypto request kind: {other}")),
    }
}

pub(crate) fn encrypt_attachment_bytes(bytes: Vec<u8>) -> Result<(Vec<u8>, Value), String> {
    let mut cursor = Cursor::new(bytes);
    let mut encryptor = AttachmentEncryptor::new(&mut cursor);
    let mut encrypted = Vec::new();
    encryptor
        .read_to_end(&mut encrypted)
        .map_err(|err| format!("Matrix attachment encryption failed: {err}"))?;
    let info = serde_json::to_value(encryptor.finish())
        .map_err(|err| format!("serialize Matrix attachment info failed: {err}"))?;
    Ok((encrypted, info))
}

pub(crate) fn decrypt_attachment_bytes(bytes: Vec<u8>, mut info: Value) -> Result<Vec<u8>, String> {
    // Matrix event content stores the MXC URI next to the encryption fields in
    // `file.url`; MediaEncryptionInfo owns only key/iv/hash/version.
    if let Some(object) = info.as_object_mut() {
        object.remove("url");
    }
    let info: MediaEncryptionInfo = serde_json::from_value(info)
        .map_err(|err| format!("invalid Matrix attachment info: {err}"))?;
    let mut cursor = Cursor::new(bytes);
    let mut decryptor = AttachmentDecryptor::new(&mut cursor, info)
        .map_err(|err| format!("Matrix attachment decryptor init failed: {err}"))?;
    let mut decrypted = Vec::new();
    decryptor
        .read_to_end(&mut decrypted)
        .map_err(|err| format!("Matrix attachment decryption failed: {err}"))?;
    Ok(decrypted)
}

fn outgoing_request_to_descriptor(
    request_id: String,
    request: &AnyOutgoingRequest,
) -> Result<MatrixCryptoOutgoingRequest, String> {
    match request {
        AnyOutgoingRequest::KeysUpload(req) => descriptor(
            request_id,
            "keysUpload",
            "POST",
            "/_matrix/client/v3/keys/upload",
            keys_upload_body(req),
        ),
        AnyOutgoingRequest::KeysQuery(req) => descriptor(
            request_id,
            "keysQuery",
            "POST",
            "/_matrix/client/v3/keys/query",
            Ok(json!({
                "timeout": req.timeout.map(|timeout| timeout.as_millis() as u64),
                "device_keys": req.device_keys,
            })),
        ),
        AnyOutgoingRequest::KeysClaim(req) => descriptor(
            request_id,
            "keysClaim",
            "POST",
            "/_matrix/client/v3/keys/claim",
            keys_claim_body(req),
        ),
        AnyOutgoingRequest::ToDeviceRequest(req) => descriptor(
            request_id,
            "toDevice",
            "PUT",
            &format!(
                "/_matrix/client/v3/sendToDevice/{}/{}",
                encode_path_segment(req.event_type.to_string().as_str()),
                encode_path_segment(req.txn_id.as_str())
            ),
            Ok(json!({ "messages": req.messages })),
        ),
        AnyOutgoingRequest::SignatureUpload(req) => descriptor(
            request_id,
            "signatureUpload",
            "POST",
            "/_matrix/client/v3/keys/signatures/upload",
            serde_json::to_value(&req.signed_keys),
        ),
        AnyOutgoingRequest::RoomMessage(req) => descriptor(
            request_id,
            "roomMessage",
            "PUT",
            &format!(
                "/_matrix/client/v3/rooms/{}/send/{}/{}",
                encode_path_segment(req.room_id.as_str()),
                encode_path_segment(req.content.event_type().to_string().as_str()),
                encode_path_segment(req.txn_id.as_str())
            ),
            serde_json::to_value(&req.content),
        ),
    }
}

fn descriptor(
    request_id: String,
    kind: &str,
    method: &str,
    path: &str,
    body: Result<Value, serde_json::Error>,
) -> Result<MatrixCryptoOutgoingRequest, String> {
    Ok(MatrixCryptoOutgoingRequest {
        request_id,
        kind: kind.to_string(),
        method: method.to_string(),
        path: path.to_string(),
        body: body.map_err(|err| format!("serialize Matrix crypto request failed: {err}"))?,
    })
}

fn keys_upload_body(
    req: &ruma::api::client::keys::upload_keys::v3::Request,
) -> Result<Value, serde_json::Error> {
    let mut body = Map::new();
    if let Some(device_keys) = &req.device_keys {
        body.insert("device_keys".to_string(), raw_to_value(device_keys)?);
    }
    if !req.one_time_keys.is_empty() {
        body.insert(
            "one_time_keys".to_string(),
            serde_json::to_value(&req.one_time_keys)?,
        );
    }
    if !req.fallback_keys.is_empty() {
        body.insert(
            "fallback_keys".to_string(),
            serde_json::to_value(&req.fallback_keys)?,
        );
    }
    Ok(Value::Object(body))
}

fn keys_claim_body(
    req: &ruma::api::client::keys::claim_keys::v3::Request,
) -> Result<Value, serde_json::Error> {
    Ok(json!({
        "timeout": req.timeout.map(|timeout| timeout.as_millis() as u64),
        "one_time_keys": req.one_time_keys,
    }))
}

fn parse_user_ids(values: &[String]) -> Result<Vec<ruma::OwnedUserId>, String> {
    values
        .iter()
        .map(|value| UserId::parse(value).map_err(|err| format!("invalid userId {value}: {err}")))
        .collect()
}

fn parse_otk_counts(
    counts: HashMap<String, u64>,
) -> Result<BTreeMap<OneTimeKeyAlgorithm, UInt>, String> {
    counts
        .into_iter()
        .map(|(key, value)| {
            let value = UInt::new(value).ok_or_else(|| {
                format!("one-time key count for {key} is outside Matrix UInt range")
            })?;
            Ok((OneTimeKeyAlgorithm::from(key), value))
        })
        .collect()
}

fn parse_otk_algorithms(values: Vec<String>) -> Result<Vec<OneTimeKeyAlgorithm>, String> {
    Ok(values.into_iter().map(OneTimeKeyAlgorithm::from).collect())
}

fn raw_from_value<T>(value: Value) -> Result<Raw<T>, String> {
    Raw::<Value>::from_json_string(value.to_string())
        .map(|raw| raw.cast_unchecked())
        .map_err(|err| format!("serialize Matrix raw JSON failed: {err}"))
}

fn raw_to_value<T>(raw: &Raw<T>) -> Result<Value, serde_json::Error> {
    serde_json::from_str(raw.json().get())
}

fn parse_matrix_response<T>(value: Value, label: &str) -> Result<T, String>
where
    T: IncomingResponse,
{
    let body = serde_json::to_vec(&value)
        .map_err(|err| format!("serialize Matrix {label} response failed: {err}"))?;
    let response = ruma::exports::http::Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(body.as_slice())
        .map_err(|err| format!("build Matrix {label} HTTP response failed: {err}"))?;
    T::try_from_http_response(response)
        .map_err(|err| format!("invalid Matrix {label} response: {err}"))
}

fn untrusted_decryption_settings() -> DecryptionSettings {
    DecryptionSettings {
        sender_device_trust_requirement: TrustRequirement::Untrusted,
    }
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn verification_rejects_unknown_flow_and_close_revokes_ephemeral_bindings() {
        let id = "matrix-verification-unit";
        super::matrix_crypto_init(init_request(id)).await.unwrap();
        let request = super::MatrixCryptoVerificationRequest {
            adapter_id: id.into(),
            action: "status".into(),
            user_id: "@bob:example.org".into(),
            device_id: None,
            flow_id: Some("missing".into()),
            qr_bytes: None,
        };
        assert_eq!(
            super::matrix_crypto_verification(request.clone())
                .await
                .unwrap_err(),
            "Matrix verification flow unavailable"
        );
        super::matrix_crypto_close(id).await.unwrap();
        assert!(!super::verification_flows().lock().contains_key(id));
        assert!(super::matrix_crypto_verification(request).await.is_err());
    }

    fn backup_request(adapter: &str, action: &str) -> super::MatrixCryptoBackupRequest {
        super::MatrixCryptoBackupRequest {
            adapter_id: adapter.to_string(),
            action: action.to_string(),
            version: None,
            backup_info: None,
            recovery_key: None,
            create_claim: None,
            rooms: None,
        }
    }

    #[tokio::test]
    async fn backup_prepare_is_stable_signed_and_intent_survives_until_matching_activation() {
        let id = "matrix-backup-prepare";
        super::matrix_crypto_init(init_request(id)).await.unwrap();
        assert!(
            super::matrix_crypto_backup(backup_request(id, "beginCreate"))
                .await
                .is_err()
        );
        let first = super::matrix_crypto_backup(backup_request(id, "prepare"))
            .await
            .unwrap();
        let second = super::matrix_crypto_backup(backup_request(id, "prepare"))
            .await
            .unwrap();
        assert!(first["recoveryKey"] == second["recoveryKey"]);
        assert!(first["backupInfo"]["auth_data"]["signatures"]
            .as_object()
            .is_some_and(|s| !s.is_empty()));
        let mut begin = backup_request(id, "beginCreate");
        begin.backup_info = Some(first["backupInfo"].clone());
        begin.create_claim = Some(uuid::Uuid::new_v4().to_string());
        super::matrix_crypto_backup(begin).await.unwrap();
        assert_eq!(
            super::matrix_crypto_backup(backup_request(id, "prepare"))
                .await
                .unwrap()["createPending"],
            true
        );
        let mut enable = backup_request(id, "enable");
        enable.version = Some("v1".into());
        let mut info = first["backupInfo"].clone();
        info["version"] = "other".into();
        enable.backup_info = Some(info.clone());
        assert!(super::matrix_crypto_backup(enable.clone()).await.is_err());
        info["version"] = "v1".into();
        enable.backup_info = Some(info);
        super::matrix_crypto_backup(enable).await.unwrap();
        assert_eq!(
            super::matrix_crypto_backup(backup_request(id, "status"))
                .await
                .unwrap()["enabled"],
            true
        );
        assert_eq!(
            super::matrix_crypto_backup(backup_request(id, "prepare"))
                .await
                .unwrap()["createPending"],
            false
        );
        super::matrix_crypto_close(id).await.unwrap();
    }

    #[tokio::test]
    async fn backup_batch_is_stable_and_only_exact_ack_marks_keys_backed_up() {
        let id = "matrix-backup-ack";
        super::matrix_crypto_init(init_request(id)).await.unwrap();
        super::matrix_crypto_share_room_key(super::MatrixCryptoShareRoomKeyRequest {
            adapter_id: id.into(),
            room_id: "!backup:example.org".into(),
            user_ids: vec![],
        })
        .await
        .unwrap();
        let prepared = super::matrix_crypto_backup(backup_request(id, "prepare"))
            .await
            .unwrap();
        let mut enable = backup_request(id, "enable");
        enable.version = Some("v1".into());
        let mut info = prepared["backupInfo"].clone();
        info["version"] = "v1".into();
        enable.backup_info = Some(info);
        super::matrix_crypto_backup(enable).await.unwrap();
        let one = super::matrix_crypto_outgoing_requests(id.into())
            .await
            .unwrap();
        let one = one.iter().find(|r| r.kind == "keysBackup").unwrap();
        let two = super::matrix_crypto_outgoing_requests(id.into())
            .await
            .unwrap();
        let two = two.iter().find(|r| r.kind == "keysBackup").unwrap();
        assert_eq!(one.request_id, two.request_id);
        assert_eq!(one.body, two.body);
        let mut ack = super::MatrixCryptoMarkSentRequest {
            adapter_id: id.into(),
            request_id: "wrong".into(),
            kind: "keysBackup".into(),
            response: serde_json::json!({"count": 1, "etag": "e"}),
        };
        super::matrix_crypto_mark_request_sent(ack.clone())
            .await
            .unwrap();
        assert_eq!(
            super::matrix_crypto_backup(backup_request(id, "status"))
                .await
                .unwrap()["backedUp"],
            0
        );
        ack.request_id = one.request_id.clone();
        super::matrix_crypto_mark_request_sent(ack).await.unwrap();
        assert_eq!(
            super::matrix_crypto_backup(backup_request(id, "status"))
                .await
                .unwrap()["backedUp"],
            1
        );
        super::matrix_crypto_close(id).await.unwrap();
    }
    #[tokio::test]
    async fn cross_signing_is_stable_and_refuses_foreign_server_identity() {
        let id = "matrix-cross-signing-stable";
        super::matrix_crypto_init(init_request(id)).await.unwrap();
        let prepare = || {
            serde_json::from_value::<super::MatrixCryptoCrossSigningRequest>(
                serde_json::json!({"adapterId":id,"action":"prepare","serverMasterKey":null}),
            )
            .unwrap()
        };
        let first = super::matrix_crypto_cross_signing(prepare()).await.unwrap();
        let second = super::matrix_crypto_cross_signing(prepare()).await.unwrap();
        let signing = |value: &serde_json::Value| {
            value["requests"]
                .as_array()
                .unwrap()
                .iter()
                .find(|request| request["kind"] == "signingKeysUpload")
                .unwrap()["body"]
                .clone()
        };
        assert_eq!(signing(&first), signing(&second));
        let mut foreign = prepare();
        foreign.server_master_key = Some("foreign-public-key".into());
        assert!(super::matrix_crypto_cross_signing(foreign)
            .await
            .unwrap_err()
            .contains("mismatch"));
        let status = super::matrix_crypto_cross_signing(
            serde_json::from_value(serde_json::json!({"adapterId":id,"action":"status"})).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(status["hasMaster"], true);
        assert_eq!(status["hasSelfSigning"], true);
        assert_eq!(status["hasUserSigning"], true);
        assert!(!serde_json::to_string(&first)
            .unwrap()
            .contains("private_key"));
        super::matrix_crypto_close(id).await.unwrap();
    }

    use super::*;

    fn init_request(adapter_id: &str) -> MatrixCryptoInitRequest {
        MatrixCryptoInitRequest {
            adapter_id: adapter_id.to_string(),
            user_id: "@alice:example.org".to_string(),
            device_id: "ALICEDEVICE".to_string(),
            store_dir: None,
            store_passphrase: None,
        }
    }

    #[tokio::test]
    async fn init_exposes_key_upload_outgoing_request() {
        matrix_crypto_reset_for_test("mx-red");

        matrix_crypto_init(init_request("mx-red")).await.unwrap();
        let requests = matrix_crypto_outgoing_requests("mx-red".to_string())
            .await
            .unwrap();

        let upload = requests
            .iter()
            .find(|req| req.kind == "keysUpload")
            .expect("OlmMachine init must expose a keysUpload request");

        assert_eq!(upload.method, "POST");
        assert_eq!(upload.path, "/_matrix/client/v3/keys/upload");
        assert!(upload.body.get("device_keys").is_some());
        assert!(!upload.request_id.is_empty());
    }

    #[tokio::test]
    async fn init_rejects_adapter_identity_mismatch() {
        matrix_crypto_reset_for_test("mx-same");

        matrix_crypto_init(init_request("mx-same")).await.unwrap();
        let mut changed = init_request("mx-same");
        changed.device_id = "OTHERDEVICE".to_string();

        let err = matrix_crypto_init(changed).await.unwrap_err();

        assert!(err.contains("different Matrix identity"));
    }

    #[tokio::test]
    async fn close_allows_device_rotation_without_deleting_the_store() {
        matrix_crypto_reset_for_test("mx-rotate");
        matrix_crypto_init(init_request("mx-rotate")).await.unwrap();

        matrix_crypto_close("mx-rotate").await.unwrap();
        assert!(get_machine("mx-rotate").is_err());

        let mut changed = init_request("mx-rotate");
        changed.device_id = "ROTATEDDEVICE".to_string();
        matrix_crypto_init(changed).await.unwrap();
        assert!(get_machine("mx-rotate").is_ok());
    }

    #[tokio::test]
    async fn close_waits_for_an_in_flight_initialization() {
        let guard = init_lock().lock().await;
        let close = tokio::spawn(async { matrix_crypto_close("mx-close-race").await });
        tokio::task::yield_now().await;
        assert!(!close.is_finished());

        drop(guard);
        close.await.unwrap().unwrap();
    }

    #[test]
    fn attachment_encrypt_decrypt_round_trips() {
        let plain = b"hello-matrix".to_vec();
        let (encrypted, info) = encrypt_attachment_bytes(plain.clone()).unwrap();

        assert_ne!(encrypted, plain);
        assert!(info.get("key").is_some());
        assert!(info.get("iv").is_some());
        assert!(info.get("hashes").is_some());

        let decrypted = decrypt_attachment_bytes(encrypted, info).unwrap();
        assert_eq!(decrypted, plain);
    }

    #[test]
    fn default_store_dir_is_scoped_by_adapter_and_device() {
        let a = default_store_dir("mx-1", "DEVA");
        let b = default_store_dir("mx-1", "DEVB");
        // A device/token rotation must NOT reuse the previous device's store.
        assert_ne!(a, b);
        let a_str = a.to_string_lossy();
        assert!(a_str.contains("mx-1"));
        assert!(a_str.contains("DEVA"));
        assert!(a.ends_with("crypto-store"));
    }

    #[test]
    fn device_path_segment_sanitizes_unsafe_chars() {
        assert_eq!(device_path_segment("ABC-1_2"), "ABC-1_2");
        assert_eq!(device_path_segment("a/b:c"), "a_b_c");
        assert_eq!(device_path_segment(""), "_");
    }

    #[tokio::test]
    async fn reset_for_test_removes_only_the_named_adapter() {
        matrix_crypto_reset_for_test("mx-keep");
        matrix_crypto_reset_for_test("mx-drop");
        matrix_crypto_init(init_request("mx-keep")).await.unwrap();
        matrix_crypto_init(init_request("mx-drop")).await.unwrap();

        // Resetting one adapter must leave the other's session intact.
        matrix_crypto_reset_for_test("mx-drop");
        assert!(matrix_crypto_outgoing_requests("mx-keep".to_string())
            .await
            .is_ok());
        assert!(get_machine("mx-drop").is_err());
    }
}
