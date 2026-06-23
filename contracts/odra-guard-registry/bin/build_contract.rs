#![no_std]
#![cfg_attr(target_arch = "wasm32", no_main)]
#![allow(unused_imports)]
use odra_guard_registry;

#[cfg(not(target_arch = "wasm32"))]
fn main() {}
