// Build entry point required by cargo-odra's wasm compilation target.
// This file is only used when building with `cargo odra build` — not in normal `cargo build`.
#[cfg(not(target_arch = "wasm32"))]
fn main() {}
