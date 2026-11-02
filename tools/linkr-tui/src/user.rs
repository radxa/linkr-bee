//! The name this host answers to, used as the default paired-device label.

/// The host's user name, capped like any label. Empty when nothing is known.
///
/// The environment is the portable source: a login shell sets `USER` (or
/// `LOGNAME` on some systems), and CI or a container can override it with
/// `LINKR_USER_NAME`. No password-database lookup is needed for a display
/// default the user can edit.
pub fn preferred_name() -> String {
    let name = ["LINKR_USER_NAME", "USER", "LOGNAME", "USERNAME"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .unwrap_or_default();
    crate::accessory::sanitize_bond_label(&name)
}
