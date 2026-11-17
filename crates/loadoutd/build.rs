//! Links the VC++ runtime (vcruntime) statically into the binaries, so they start on a Windows without the VC++ Redistributable;
//! the universal CRT (ucrtbase) stays the system one, part of every Windows 10 and 11. Pure Rust, no C++: the static runtime is
//! safe here (loadout-ml cannot do this, its linked ONNX Runtime is built for the DLL runtime). The same file is in context-toolkit.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        for lib in [
            "vcruntime.lib",
            "vcruntimed.lib",
            "msvcrt.lib",
            "msvcrtd.lib",
            "libucrt.lib",
            "libucrtd.lib",
            "libcmtd.lib",
        ] {
            println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB:{lib}");
        }
        for lib in ["libvcruntime.lib", "libcmt.lib", "ucrt.lib"] {
            println!("cargo:rustc-link-arg-bins=/DEFAULTLIB:{lib}");
        }
    }
    println!("cargo:rerun-if-changed=build.rs");
}
