//! Shared, platform-independent source proof for Host preparation and guest
//! promotion. This library has no process-launch or provider authority.

pub mod source_tree;

pub mod observation;

pub mod qualification;

// Exercise portable framing/dirfd policies on macOS without exposing an
// unconfined production execution API from the shared proof library.
#[cfg(all(test, target_os = "macos"))]
mod operations;

pub mod lume;
