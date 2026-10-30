/* Internal Capture App ABI. Not a daemon IPC or public plugin API. */
#pragma once
#include <stddef.h>
#include <stdint.h>
#ifdef _WIN32
#define GH_API __declspec(dllexport)
#else
#define GH_API __attribute__((visibility("default")))
#endif
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { int32_t display_id, width, height, fps, bitrate_kbps, input_only, source_width, source_height; } gh_capture_config;
/* Last argument is a bit set: 1 keyframe, 2 repeat (the held picture encoded
 * again; not a new capture of the desktop). */
typedef void (*gh_video_cb)(void*, const uint8_t*, size_t, int64_t, int32_t);
typedef void (*gh_audio_cb)(void*, const uint8_t*, size_t, int32_t);
typedef void (*gh_ended_cb)(void*, const char*);
/* Local UI only. desired=-1 polls; bits 0/1 request sharing/control.
 * Returned bits: shared, control-enabled, viewing, controlling, release-unknown,
 * capture-available, input-permitted, app-stopping, session-closing.
 * Callback must not throw across this ABI. */
typedef int32_t (*gh_policy_cb)(void*, int32_t desired);
GH_API int32_t gh_capture_manage(const char* target, gh_policy_cb, void*);
#ifdef __APPLE__
/* Optional ABI 4 extension: explicit settings action, never called by probe,
 * discovery or normal start. kind=0 screen, kind=1 input; 1 allowed, 0 pending. */
GH_API int32_t gh_capture_request_permission(int32_t kind);
/* Explicit CLI action only: main-thread AppKit lifetime while Human grants
 * permission. Same result codes; -2 means Settings dispatch failed. Never
 * called by probe/start; polls preflight without repeating request APIs. */
GH_API int32_t gh_capture_request_permission_interactive(int32_t kind, uint32_t timeout_ms);
#endif
GH_API uint32_t gh_capture_abi(void);
GH_API char* gh_capture_probe(void);
/* Cheap current OS permission/geometry check; never probes GPU encoders.
 * 1 ready, 0 target changed, -1/-2 permission, -3 inactive/locked OS session. */
GH_API int32_t gh_capture_preflight(const char* display_key, int32_t width, int32_t height, int32_t input);
GH_API void gh_capture_free(char*);
GH_API void* gh_capture_start(const gh_capture_config*, const char* expected_display_key, gh_video_cb, gh_audio_cb, gh_ended_cb, void*, char**);
/* Host audio fact after start: 1 flowing, 0 unavailable (reason is a bounded
 * engine message, free with gh_capture_free), -1 invalid/input-only handle. */
GH_API int32_t gh_capture_audio_status(void*, char** reason);
GH_API void gh_capture_stop(void*);
GH_API int32_t gh_capture_target_live(void*);
GH_API void gh_capture_keyframe(void*);
GH_API void gh_capture_bitrate(void*, int32_t);
GH_API void gh_capture_input(void*, int32_t, int32_t, int32_t, const char*);
#ifdef __cplusplus
}
#endif
