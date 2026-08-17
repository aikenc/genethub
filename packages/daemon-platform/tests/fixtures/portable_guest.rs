#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_info: &PanicInfo<'_>) -> ! {
    loop {
        core::hint::spin_loop();
    }
}

#[unsafe(export_name = "genehub-abi-version")]
pub extern "C" fn genehub_abi_version() -> i32 {
    1
}

#[unsafe(export_name = "genehub-self-check")]
pub extern "C" fn genehub_self_check() -> i32 {
    1
}

#[unsafe(export_name = "genehub-probe")]
pub extern "C" fn genehub_probe(input: i64) -> i64 {
    input + 77
}
