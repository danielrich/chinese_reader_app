//! Dictionary source parsers and importers.
//!
//! This module contains parsers for various dictionary formats:
//! - CC-CEDICT: Community-maintained Chinese-English dictionary
//! - MOE Dict: Taiwan Ministry of Education dictionary
//! - Kangxi: Historical character dictionary

pub mod cedict;
pub mod kangxi;
pub mod moedict;

pub use cedict::import_cedict;
pub use kangxi::import_kangxi_text;
pub use moedict::import_moedict;
