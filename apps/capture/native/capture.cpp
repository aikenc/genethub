#include "capture.h"
#include <mw/native/NativeHost.h>
#include <algorithm>
#include <cstring>
#include <cstdlib>
#include <sstream>
#include <stdexcept>
#include <optional>
#include <atomic>
#include <cstdio>
#include <mutex>
#ifdef _WIN32
#include <windows.h>
#include <wtsapi32.h>
#include "input/windows/Win32Input.h"
#endif
#ifdef __APPLE__
#include <CoreGraphics/CoreGraphics.h>
#include <ColorSync/ColorSync.h>
extern "C" void* gh_native_mac_input_create(int, const char*, std::string&);
extern "C" void gh_native_mac_input_destroy(void*);
extern "C" void gh_native_mac_input_send(void*, const mw::native::InputEvent&);
#endif
using namespace mw::native;
namespace {
// Why the host's audio is not flowing, from the engine's own warning. The
// native logger also carries input/window traces: only this one bounded
// fact is kept, and only the audio line is ever parsed.
std::mutex g_audio_mutex;
std::string g_audio_reason;
void note_audio(const std::string& message) {
    const char* marker="streaming silent";
    const auto at=message.find(marker);
    if (at==std::string::npos || message.find("audio")==std::string::npos) return;
    auto detail=message.substr(at+std::strlen(marker));
    while (!detail.empty() && (detail[0]==':'||detail[0]==' ')) detail.erase(0,1);
    if (detail.size()>200) detail.resize(200);
    for (char& c:detail) if (static_cast<unsigned char>(c)<32) c=' ';
    std::lock_guard<std::mutex> lock(g_audio_mutex);
    g_audio_reason=detail.empty()?"audio_unavailable":detail;
}
void configure_diagnostics() {
    static std::once_flag configured;
    std::call_once(configured, [] {
        const char* enabled=std::getenv("GENEHUB_CAPTURE_NATIVE_DIAGNOSTICS");
        const bool forward=enabled && std::strcmp(enabled,"1")==0;
        NativeHost::setLogSink([forward](int level,const std::string& message) {
            note_audio(message);
            if (!forward) return;
            // Only bounded media/backend diagnostics. The native logger also
            // carries keyboard/layout and window-title traces: never forward
            // those, even when explicitly diagnosing the media pipeline.
            if (message.find("[native]")!=0 || message.find("input")!=std::string::npos ||
                message.find("window")!=std::string::npos) return;
            const char* topics[]={"duplication","NVENC","capture opens","display is away",
                "display still away","audio unavailable","audio:","cross-GPU","D3D","encoder"};
            bool selected=false;
            for (const char* topic:topics) if (message.find(topic)!=std::string::npos) selected=true;
            if (!selected) return;
            static std::atomic<unsigned> count{0};
            if (count.fetch_add(1,std::memory_order_relaxed)<64)
                std::fprintf(stderr,"Capture native[%d]: %.768s\n",level,message.c_str());
        });
    });
}
#ifdef __APPLE__
// Match MacProbe/ScreenCaptureKit's physical mode dimensions. The legacy
// CGDisplayPixelsWide/High APIs report logical dimensions on Retina modes.
// A locked screen (or a session that is not the console user's) still has
// online displays and passes the privacy preflight, but shows the login
// window and swallows input. Treat it as an unavailable desktop.
bool mac_session_unlocked() {
    CFDictionaryRef session=CGSessionCopyCurrentDictionary();
    if (!session) return false;
    bool usable=true;
    const void* locked=CFDictionaryGetValue(session,CFSTR("CGSSessionScreenIsLocked"));
    if (locked && CFGetTypeID(locked)==CFBooleanGetTypeID() && CFBooleanGetValue(static_cast<CFBooleanRef>(locked))) usable=false;
    const void* console=CFDictionaryGetValue(session,kCGSessionOnConsoleKey);
    if (console && CFGetTypeID(console)==CFBooleanGetTypeID() && !CFBooleanGetValue(static_cast<CFBooleanRef>(console))) usable=false;
    CFRelease(session);
    return usable;
}
bool mac_display_pixels(CGDirectDisplayID display, size_t& width, size_t& height) {
    CGDisplayModeRef mode=CGDisplayCopyDisplayMode(display);
    if (!mode) return false;
    width=CGDisplayModeGetPixelWidth(mode); height=CGDisplayModeGetPixelHeight(mode);
    CGDisplayModeRelease(mode);
    return width>0 && height>0;
}
#endif
#ifdef _WIN32
// A disconnected/locked session can still expose a desktop named "Default"
// and successfully create DXGI/NVENC resources, without presenting any user
// frames. Check the OS session state as well as the desktop name. Windows 10+
// is our minimum; the reversed Windows 7 lock flags do not apply.
bool windows_session_live() {
    LPWSTR buffer=nullptr; DWORD bytes=0;
    if (!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,WTS_CURRENT_SESSION,
                                     WTSSessionInfoEx,&buffer,&bytes)) return false;
    bool live=false;
    if (bytes>=sizeof(WTSINFOEXW)) {
        const auto* info=reinterpret_cast<const WTSINFOEXW*>(buffer);
        live=info->Level==1 && info->Data.WTSInfoExLevel1.SessionState==WTSActive &&
            info->Data.WTSInfoExLevel1.SessionFlags==WTS_SESSIONSTATE_UNLOCK;
    }
    WTSFreeMemory(buffer); return live;
}
// The input desktop must be the user's normal one: a UAC consent or secure
// attention desktop shows nothing we can capture and accepts no injected input.
// Read only: never follows or switches to it.
bool windows_input_desktop_normal() {
    HDESK desktop=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
    if (!desktop) return false;
    wchar_t name[128]{}; DWORD needed=0;
    const bool normal=GetUserObjectInformationW(desktop,UOI_NAME,name,sizeof(name),&needed) && _wcsicmp(name,L"Default")==0;
    CloseDesktop(desktop); return normal;
}
std::string utf8(const wchar_t* value) {
    int size=WideCharToMultiByte(CP_UTF8,0,value,-1,nullptr,0,nullptr,nullptr);
    if (!size) return {};
    std::string out(size,'\0'); WideCharToMultiByte(CP_UTF8,0,value,-1,out.data(),size,nullptr,nullptr);
    out.pop_back(); return out;
}
#endif
// Resolve the selected display by stable identity using OS APIs only. GPU
// codec enumeration can take seconds and must never run on a lease heartbeat.
std::optional<DisplayInfo> current_display(const char* key, int id=-1) {
    if (!key || !*key) return {};
#ifdef _WIN32
    for (DWORD a=0;;a++) {
        DISPLAY_DEVICEW adapter{}; adapter.cb=sizeof(adapter);
        if (!EnumDisplayDevicesW(nullptr,a,&adapter,0)) break;
        if (!(adapter.StateFlags&DISPLAY_DEVICE_ATTACHED_TO_DESKTOP)) continue;
        for (DWORD m=0;;m++) {
            DISPLAY_DEVICEW monitor{}; monitor.cb=sizeof(monitor);
            if (!EnumDisplayDevicesW(adapter.DeviceName,m,&monitor,EDD_GET_DEVICE_INTERFACE_NAME)) break;
            if (_stricmp(utf8(monitor.DeviceID).c_str(),key)!=0) continue;
            DEVMODEW mode{}; mode.dmSize=sizeof(mode);
            if (!EnumDisplaySettingsW(adapter.DeviceName,ENUM_CURRENT_SETTINGS,&mode)) return {};
            DisplayInfo d; d.id=id; d.key=key; d.osName=utf8(adapter.DeviceName);
            d.width=mode.dmPelsWidth; d.height=mode.dmPelsHeight; return d;
        }
    }
#elif defined(__APPLE__)
    // A fresh input-only process has not run NativeHost::probe(). Establish
    // the public display connection before UUID lookup: on macOS 26 the
    // ColorSync lookup otherwise aborts in CGS_REQUIRE_INIT, before TCC.
    CGDirectDisplayID online[32]; uint32_t online_count=0;
    if (CGGetOnlineDisplayList(32,online,&online_count)!=kCGErrorSuccess || !online_count) return {};
    CFStringRef text=CFStringCreateWithCString(kCFAllocatorDefault,key,kCFStringEncodingUTF8);
    CFUUIDRef uuid=text?CFUUIDCreateFromString(kCFAllocatorDefault,text):nullptr;
    if (text) CFRelease(text);
    CGDirectDisplayID display=uuid?CGDisplayGetDisplayIDFromUUID(uuid):0;
    if (uuid) CFRelease(uuid);
    if (display && CGDisplayIsOnline(display)) {
        size_t width=0,height=0;
        if (!mac_display_pixels(display,width,height)) return {};
        DisplayInfo d; d.id=id; d.key=key;
        d.width=width; d.height=height; return d;
    }
#else
    (void)id;
#endif
    return {};
}
char* copy(const std::string& value) {
    auto* out = static_cast<char*>(std::malloc(value.size() + 1));
    if (!out) return nullptr;
    std::memcpy(out, value.c_str(), value.size() + 1); return out;
}
std::string quote(const std::string& value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c < 32) { const char* hex="0123456789abcdef"; out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
        else out += c;
    }
    return out + '"';
}
// Cheap geometry checks use OS display APIs, never encoder/GPU probing. The
// independent input process checks this even when the parent stops running.
struct TargetSnapshot {
#ifdef _WIN32
    std::wstring device;
    DEVMODEW mode{};
    std::wstring monitor;
    int left=0,top=0,width=0,height=0;
    bool read(DEVMODEW& value, std::wstring& identity) const {
        value={}; value.dmSize=sizeof(value);
        DISPLAY_DEVICEW display{}; display.cb=sizeof(display);
        if (!EnumDisplaySettingsW(device.c_str(),ENUM_CURRENT_SETTINGS,&value) ||
            !EnumDisplayDevicesW(device.c_str(),0,&display,0)) return false;
        identity=display.DeviceID; return true;
    }
    explicit TargetSnapshot(const DisplayInfo& selected) {
        int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,selected.osName.c_str(),-1,nullptr,0);
        if (!n) throw std::runtime_error("target_changed");
        device.resize(n); MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,selected.osName.c_str(),-1,device.data(),n);
        if (!read(mode,monitor)) throw std::runtime_error("target_changed");
        left=GetSystemMetrics(SM_XVIRTUALSCREEN); top=GetSystemMetrics(SM_YVIRTUALSCREEN);
        width=GetSystemMetrics(SM_CXVIRTUALSCREEN); height=GetSystemMetrics(SM_CYVIRTUALSCREEN);
    }
    bool live() const {
        DEVMODEW current{}; std::wstring identity;
        return windows_session_live() && windows_input_desktop_normal() && read(current,identity) && identity==monitor &&
            current.dmPosition.x==mode.dmPosition.x && current.dmPosition.y==mode.dmPosition.y &&
            current.dmPelsWidth==mode.dmPelsWidth && current.dmPelsHeight==mode.dmPelsHeight &&
            current.dmDisplayOrientation==mode.dmDisplayOrientation &&
            left==GetSystemMetrics(SM_XVIRTUALSCREEN) && top==GetSystemMetrics(SM_YVIRTUALSCREEN) &&
            width==GetSystemMetrics(SM_CXVIRTUALSCREEN) && height==GetSystemMetrics(SM_CYVIRTUALSCREEN);
    }
#elif defined(__APPLE__)
    CGDirectDisplayID id=0;
    CGRect rect{}; size_t width=0,height=0; double rotation=0;
    explicit TargetSnapshot(const DisplayInfo& selected) {
        CFStringRef text=CFStringCreateWithCString(kCFAllocatorDefault,selected.key.c_str(),kCFStringEncodingUTF8);
        CFUUIDRef uuid=text?CFUUIDCreateFromString(kCFAllocatorDefault,text):nullptr;
        if (text) CFRelease(text);
        if (uuid) { id=CGDisplayGetDisplayIDFromUUID(uuid); CFRelease(uuid); }
        if (!id || !CGDisplayIsOnline(id)) throw std::runtime_error("target_changed");
        if (!mac_display_pixels(id,width,height)) throw std::runtime_error("target_changed");
        rect=CGDisplayBounds(id); rotation=CGDisplayRotation(id);
    }
    bool live() const {
        size_t current_width=0,current_height=0;
        return mac_session_unlocked() && CGDisplayIsOnline(id) && !CGDisplayIsAsleep(id) && CGRectEqualToRect(rect,CGDisplayBounds(id)) &&
            mac_display_pixels(id,current_width,current_height) &&
            width==current_width && height==current_height && rotation==CGDisplayRotation(id);
    }
#else
    explicit TargetSnapshot(const DisplayInfo&) {}
    bool live() const { return true; }
#endif
};
struct Capture {
    explicit Capture(const DisplayInfo& display): target(display) {}
    TargetSnapshot target;
    std::unique_ptr<Session> session;
#ifdef _WIN32
    std::unique_ptr<input::Win32Input> input;
#endif
#ifdef __APPLE__
    void* input=nullptr;
    ~Capture() { gh_native_mac_input_destroy(input); }
#endif
};
}
uint32_t gh_capture_abi(void) { return 5; }
int32_t gh_capture_preflight(const char* key,int32_t width,int32_t height,int32_t input) {
    try {
#ifdef _WIN32
        // The input-only child deliberately skips the GPU probe. It still
        // needs physical coordinates for both DEVMODE and Win32Input's
        // virtual-desktop metrics (including mixed-DPI secondary monitors).
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
#endif
        const auto display=current_display(key);
        if (!display || display->width!=width || display->height!=height) return 0;
#ifdef __APPLE__
        if (!mac_session_unlocked()) return -3;
        if (!CGPreflightScreenCaptureAccess()) return -1;
        if (input && !CGPreflightPostEventAccess()) return -2;
#elif defined(_WIN32)
        if (!windows_session_live()) return -3;
        if (!windows_input_desktop_normal()) return -1;
        (void)input;
#else
        (void)input;
#endif
        return 1;
    } catch (...) { return 0; }
}
void gh_capture_free(char* value) { std::free(value); }
char* gh_capture_probe(void) {
    try {
        configure_diagnostics();
        #ifdef _WIN32
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        #endif
        auto caps = NativeHost::probe(); std::ostringstream out;
        std::string reason=caps.diagnostic;
        #if defined(__linux__) && !defined(MW_NATIVE_LINUX_GFX)
        reason="native_graphics_backend_not_built";
        #endif
        out << "{\"available\":" << (caps.available ? "true" : "false")
            << ",\"inputPermission\":" << (caps.inputPermission ? "true" : "false")
            << ",\"reason\":" << quote(reason) << ",\"displays\":[";
        bool first=true;
        for (const auto& display : caps.displays) {
            if (!first) out << ','; first=false;
            out << "{\"id\":" << display.id << ",\"name\":" << quote(display.label)
                << ",\"width\":" << display.width << ",\"height\":" << display.height << ",\"key\":" << quote(display.key) << '}';
        }
        out << "]}"; return copy(out.str());
    } catch (...) { return copy("{\"available\":false,\"inputPermission\":false,\"displays\":[],\"reason\":\"native_probe_failed\"}"); }
}
void* gh_capture_start(const gh_capture_config* cfg, const char* expected_key, gh_video_cb video, gh_audio_cb audio,
                       gh_ended_cb ended, void* user, char** error) {
    try {
        if (!cfg || cfg->fps < 1 || cfg->fps > 120 || cfg->bitrate_kbps < 256 || cfg->bitrate_kbps > 50000)
            throw std::runtime_error("invalid native configuration");
        const int preflight=gh_capture_preflight(expected_key,cfg->source_width,cfg->source_height,cfg->input_only);
        if (preflight!=1)
            throw std::runtime_error(preflight==-3?"desktop_unavailable":"target_or_permission_changed");
        if (cfg->input_only) {
            const auto selected=current_display(expected_key,cfg->display_id);
            if (!selected) throw std::runtime_error("target_changed");
            auto capture=std::make_unique<Capture>(*selected); std::string reason;
#ifdef _WIN32
            const auto& mode=capture->target.mode;
            mw::native::capture::DesktopRect rect{mode.dmPosition.x,mode.dmPosition.y,
                mode.dmPosition.x+static_cast<int>(mode.dmPelsWidth),mode.dmPosition.y+static_cast<int>(mode.dmPelsHeight)};
            capture->input=std::make_unique<input::Win32Input>(rect);
            capture->input->setAllowElevated(false); capture->input->setVirtualMouse(0);
            if (!capture->input->start(reason)) throw std::runtime_error(reason);
            return capture.release();
#elif defined(__APPLE__)
            capture->input=gh_native_mac_input_create(cfg->display_id,expected_key,reason);
            if (!capture->input) throw std::runtime_error(reason);
            return capture.release();
#else
            throw std::runtime_error("input_backend_unavailable");
#endif
        }
        configure_diagnostics();
        { std::lock_guard<std::mutex> lock(g_audio_mutex); g_audio_reason.clear(); }
        const auto caps = NativeHost::probe();
        const auto selected = std::find_if(caps.displays.begin(), caps.displays.end(), [&](const DisplayInfo& display) {
            return display.id == cfg->display_id && expected_key && display.key == expected_key;
        });
        if (selected == caps.displays.end() || selected->key.empty() || selected->width!=cfg->source_width || selected->height!=cfg->source_height) throw std::runtime_error("target_changed");
        const int display_width=selected->width, display_height=selected->height;
        SessionConfig config;
        config.displayId=cfg->display_id; config.width=cfg->width; config.height=cfg->height;
        config.fps=cfg->fps; config.maxFps=cfg->fps; config.bitrateKbps=cfg->bitrate_kbps;
        config.clientCodecs={Codec::H264}; config.hdr=false; config.yuv444=false;
        // Use the established Windows GPU path, not upstream's experimental
        // D3D12 encoders. Other platforms ignore this Windows-specific choice.
        config.videoPipeline=VideoPipeline::D3d11;
        config.allowElevatedInput=false; config.muteHostAudio=false;
        auto capture=std::make_unique<Capture>(*selected); std::string reason;
        capture->session=NativeHost::createSession(config,
            [=](const EncodedFrame& frame){ if(video) video(user,frame.data,frame.size,frame.encodedUs,(frame.keyframe?1:0)|(frame.repeat?2:0)); },
            cfg->input_only ? AudioCallback{} : AudioCallback{[=](const AudioPacket& packet){ if(audio) audio(user,packet.data,packet.size,packet.samplesPerChannel); }},
            {}, {}, [=](const std::string& reason){ if(ended) ended(user,reason.c_str()); }, reason);
        if (capture->session) capture->session->setDisplayFormatCallback([=](const DisplayFormat& format) {
            if ((format.displayWidth != display_width || format.displayHeight != display_height) && ended) ended(user,"target_changed");
        });
        if (!capture->session || !capture->session->start(reason)) throw std::runtime_error(reason);
        if (!cfg->input_only) capture->session->setFrameFloorFps(2);
        if (!cfg->input_only && capture->session->info().codec != Codec::H264)
            throw std::runtime_error("native encoder did not provide H.264");
        return capture.release();
    } catch (const std::exception& exception) { if(error) *error=copy(exception.what()); return nullptr; }
      catch (...) { if(error) *error=copy("native_start_failed"); return nullptr; }
}
int32_t gh_capture_audio_status(void* handle, char** reason) {
    if (reason) *reason=nullptr;
    try {
        auto* capture=static_cast<Capture*>(handle);
        if (!capture || !capture->session) return -1;
        if (capture->session->info().audio) return 1;
        std::string text;
        { std::lock_guard<std::mutex> lock(g_audio_mutex); text=g_audio_reason; }
        if (text.empty()) text="audio_unavailable";
        if (reason) *reason=copy(text);
        return 0;
    } catch (...) { return -1; }
}
void gh_capture_stop(void* handle) {
    if (!handle) return;
    auto capture=std::unique_ptr<Capture>(static_cast<Capture*>(handle)); if(capture->session) capture->session->stop();
}
int32_t gh_capture_target_live(void* handle) {
    try { return handle && static_cast<Capture*>(handle)->target.live() ? 1 : 0; }
    catch (...) { return 0; }
}
void gh_capture_keyframe(void* handle) { if(handle && static_cast<Capture*>(handle)->session) static_cast<Capture*>(handle)->session->requestKeyframe(); }
void gh_capture_bitrate(void* handle,int32_t kbps) { if(handle && static_cast<Capture*>(handle)->session) static_cast<Capture*>(handle)->session->setTargetBitrate(std::clamp(kbps,256,50000)); }
void gh_capture_input(void* handle,int32_t kind,int32_t a,int32_t b,const char* text) {
    if (!handle) return;
    InputEvent event;
    switch (kind) {
        case 1: event.type=InputEvent::Type::KeyDown; event.keyCode=static_cast<int16_t>(a); break;
        case 2: event.type=InputEvent::Type::KeyUp; event.keyCode=static_cast<int16_t>(a); break;
        case 3: event.type=InputEvent::Type::Utf8Text; event.text=text?text:""; break;
        case 4: event.type=InputEvent::Type::MouseMoveAbsolute;
                event.positionX=static_cast<int16_t>(std::clamp(a,0,32767)); event.positionY=static_cast<int16_t>(std::clamp(b,0,32767));
                event.referenceWidth=32767; event.referenceHeight=32767; break;
        case 5: event.type=InputEvent::Type::MouseMoveRelative;
                event.deltaX=static_cast<int16_t>(std::clamp(a,-32767,32767)); event.deltaY=static_cast<int16_t>(std::clamp(b,-32767,32767)); break;
        case 6: event.type=InputEvent::Type::MouseButtonDown; event.button=a; break;
        case 7: event.type=InputEvent::Type::MouseButtonUp; event.button=a; break;
        case 8: event.type=InputEvent::Type::MouseScrollVertical; event.scrollAmount=static_cast<int16_t>(std::clamp(a,-1200,1200)); break;
        case 9: event.type=InputEvent::Type::MouseScrollHorizontal; event.scrollAmount=static_cast<int16_t>(std::clamp(a,-1200,1200)); break;
        default: return;
    }
    auto* capture=static_cast<Capture*>(handle);
    #ifdef _WIN32
    if (capture->input) { capture->input->inject(event); return; }
    #endif
    #ifdef __APPLE__
    if (capture->input) { gh_native_mac_input_send(capture->input,event); return; }
    #endif
    capture->session->sendInput(event);
}
