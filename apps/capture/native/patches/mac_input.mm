/* GeneHub's narrow input-only seam, compiled INSIDE the pinned native module.
 * Reuses the module's CGEvent mapping/drag/modifier/layout handling; it does
 * not create a second capture/encoder in the independent input guard. */
#include "MacDisplays.h"
#include "../../input/macos/CgInput.h"
#include <memory>
#include <string>

extern "C" void* gh_native_mac_input_create(int displayId, const char* key, std::string& error) {
    const auto displays=mw::native::platform::listDisplays();
    if (displayId<0 || static_cast<size_t>(displayId)>=displays.size() || !key || displays[displayId].stableKey!=key) {
        error="target_changed"; return nullptr;
    }
    const auto& display=displays[displayId];
    auto input=std::make_unique<mw::native::input::CgInput>();
    input->setDisplayRect(display.left,display.top,display.right,display.bottom);
    if (!input->start(error)) return nullptr;
    return input.release();
}
extern "C" void gh_native_mac_input_destroy(void* input) {
    if (input) { auto owned=std::unique_ptr<mw::native::input::CgInput>(static_cast<mw::native::input::CgInput*>(input)); owned->stop(); }
}
extern "C" void gh_native_mac_input_send(void* input, const mw::native::InputEvent& event) {
    if (input) static_cast<mw::native::input::CgInput*>(input)->inject(event);
}
