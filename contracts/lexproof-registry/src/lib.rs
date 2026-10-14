#![no_std]

#[cfg(not(target_arch = "wasm32"))]
compile_error!("target arch should be wasm32: compile with '--target wasm32-unknown-unknown'");

extern crate alloc;

use alloc::{
    string::{String, ToString},
    vec::Vec,
};

use casper_contract::{
    contract_api::{runtime, storage},
    unwrap_or_revert::UnwrapOrRevert,
};

use casper_types::{
    addressable_entity::{EntityEntryPoint as EntryPoint, EntryPoints},
    api_error::ApiError,
    contracts::NamedKeys,
    CLType, EntryPointAccess, EntryPointPayment, EntryPointType, Parameter, URef,
};

// Names used by the LexProof backend and frontend. Do not rename.
const REGISTRY_DICT: &str = "lexproof_registry";
const ENTRY_REGISTER: &str = "register_hash";
const ARG_DOC_HASH: &str = "document_hash";

// Named keys created in the installing account.
const PACKAGE_NAME: &str = "lexproof_package_hash";
const ACCESS_NAME: &str = "lexproof_access_uref";
const VERSION_KEY: &str = "lexproof_contract_version";
const CONTRACT_KEY: &str = "lexproof_contract_hash";

fn is_valid_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Registers a document hash. Fails if it is already registered.
#[no_mangle]
pub extern "C" fn register_hash() {
    let doc_hash: String = runtime::get_named_arg(ARG_DOC_HASH);

    if !is_valid_sha256_hex(&doc_hash) {
        runtime::revert(ApiError::InvalidArgument);
    }

    let dict_uref: URef = runtime::get_key(REGISTRY_DICT)
        .unwrap_or_revert_with(ApiError::MissingKey)
        .into_uref()
        .unwrap_or_revert_with(ApiError::UnexpectedKeyVariant);

    let existing: Option<bool> = storage::dictionary_get(dict_uref, &doc_hash).unwrap_or_revert();

    if existing.is_some() {
        runtime::revert(ApiError::User(1));
    }

    storage::dictionary_put(dict_uref, &doc_hash, true);
}

/// Runs once when the contract is installed.
#[no_mangle]
pub extern "C" fn call() {
    // Dictionary that stores the registered document hashes.
    let dict_uref: URef = storage::new_dictionary(REGISTRY_DICT).unwrap_or_revert();

    let mut named_keys = NamedKeys::new();
    named_keys.insert(String::from(REGISTRY_DICT), dict_uref.into());

    let mut parameters = Vec::new();
    parameters.push(Parameter::new(ARG_DOC_HASH, CLType::String));

    let mut entry_points = EntryPoints::new();
    entry_points.add_entry_point(EntryPoint::new(
        ENTRY_REGISTER,
        parameters,
        CLType::Unit,
        EntryPointAccess::Public,
        EntryPointType::Called,
        EntryPointPayment::Caller,
    ));

    let (contract_hash, contract_version) = storage::new_contract(
        entry_points,
        Some(named_keys),
        Some(PACKAGE_NAME.to_string()),
        Some(ACCESS_NAME.to_string()),
        None,
    );

    runtime::put_key(VERSION_KEY, storage::new_uref(contract_version).into());
    runtime::put_key(CONTRACT_KEY, contract_hash.into());
}