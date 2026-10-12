#![no_std]

extern crate alloc;

use alloc::string::{String, ToString};
use casper_contract::contract_api::{runtime, storage};
use casper_contract::unwrap_or_revert::UnwrapOrRevert;
use casper_types::{
    ApiError, CLType, EntryPoint, EntryPointAccess, EntryPointType, EntryPoints,
    Parameter, URef,
};

const REGISTRY_KEY: &str = "lexproof_registry";

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

#[no_mangle]
pub extern "C" fn register_hash() {
    let document_hash: String = runtime::get_named_arg("document_hash");

    if !valid_hash(&document_hash) {
        runtime::revert(ApiError::InvalidArgument);
    }

    let registry: URef = match runtime::get_key(REGISTRY_KEY) {
        Some(casper_types::Key::URef(uref)) => uref,
        _ => storage::new_dictionary(REGISTRY_KEY)
            .unwrap_or_revert(),
    };

    let existing: Option<bool> =
        storage::dictionary_get(registry, &document_hash)
            .unwrap_or_revert();

    if existing == Some(true) {
        runtime::revert(ApiError::User(1));
    }

    storage::dictionary_put(registry, &document_hash, true);
}

#[no_mangle]
pub extern "C" fn verify_hash() {
    let document_hash: String = runtime::get_named_arg("document_hash");

    if !valid_hash(&document_hash) {
        runtime::revert(ApiError::InvalidArgument);
    }

    let registry: URef = match runtime::get_key(REGISTRY_KEY) {
        Some(casper_types::Key::URef(uref)) => uref,
        _ => runtime::revert(ApiError::User(2)),
    };

    let exists: bool =
        storage::dictionary_get(registry, &document_hash)
            .unwrap_or_revert()
            .unwrap_or(false);

    runtime::ret(casper_types::CLValue::from_t(exists).unwrap_or_revert());
}

#[no_mangle]
pub extern "C" fn call() {
    let mut entry_points = EntryPoints::new();

    entry_points.add_entry_point(EntryPoint::new(
        "register_hash",
        alloc::vec![Parameter::new("document_hash", CLType::String)],
        CLType::Unit,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    entry_points.add_entry_point(EntryPoint::new(
        "verify_hash",
        alloc::vec![Parameter::new("document_hash", CLType::String)],
        CLType::Bool,
        EntryPointAccess::Public,
        EntryPointType::Contract,
    ));

    let (contract_hash, _) = storage::new_contract(
        entry_points,
        None,
        Some("lexproof_contract_hash".to_string()),
        Some("lexproof_contract_uref".to_string()),
    );

    runtime::put_key(
        "lexproof_contract_hash",
        contract_hash.into(),
    );
}