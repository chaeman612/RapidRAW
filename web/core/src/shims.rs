//! Stand-ins for desktop types that the extracted code refers to.

/// Desktop variant also wraps mapped GPU readback buffers; the web build only
/// ever hands over owned RGBA8 bytes.
pub enum AnalyticsPixels {
    Owned(Vec<u8>),
}

impl std::ops::Deref for AnalyticsPixels {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        match self {
            AnalyticsPixels::Owned(data) => data,
        }
    }
}
