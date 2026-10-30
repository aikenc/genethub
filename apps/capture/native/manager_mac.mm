// Source controls and explicit settings actions. No automatic permission requests.
#include "capture.h"
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

int32_t gh_capture_request_permission(int32_t kind) {
    @autoreleasepool {
        bool allowed=false;
        NSString* pane;
        if (kind==0) {
            allowed=CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess();
            pane=@"x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
        } else if (kind==1) {
            allowed=CGPreflightPostEventAccess() || CGRequestPostEventAccess();
            pane=@"x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
        } else { return -1; }
        if (!allowed && ![[NSWorkspace sharedWorkspace] openURL:[NSURL URLWithString:pane]]) return -2;
        return allowed?1:0;
    }
}

int32_t gh_capture_request_permission_interactive(int32_t kind, uint32_t timeout_ms) {
    @autoreleasepool {
        if ((kind!=0 && kind!=1) || timeout_ms==0 || timeout_ms>120000 || ![NSThread isMainThread]) return -1;
        const auto permitted=[kind]() {
            return kind==0?CGPreflightScreenCaptureAccess():CGPreflightPostEventAccess();
        };
        if (permitted()) return 1;
        // A CLI that exits immediately after dispatch cannot observe the
        // user's response and may disappear before asynchronous AppKit work
        // finishes. Keep just this explicit action alive, with no custom UI.
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];
        [NSApp activateIgnoringOtherApps:YES];
        const int32_t requested=gh_capture_request_permission(kind);
        if (requested!=0) return requested;
        const NSTimeInterval end=NSProcessInfo.processInfo.systemUptime+timeout_ms/1000.0;
        while (NSProcessInfo.processInfo.systemUptime<end) {
            if (permitted()) return 1;
            NSEvent* event=[NSApp nextEventMatchingMask:NSEventMaskAny
                untilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]
                inMode:NSDefaultRunLoopMode dequeue:YES];
            if (event) [NSApp sendEvent:event];
            [NSApp updateWindows];
        }
        return permitted()?1:0;
    }
}

@interface GHManager : NSObject<NSWindowDelegate>
@property NSWindow* window;
@property NSButton* share;
@property NSButton* control;
@property NSTextField* status;
@property NSTimer* timer;
@property(assign) gh_policy_cb callback;
@property(assign) void* context;
- (void)refresh:(id)sender;
- (void)change:(id)sender;
- (void)recording:(id)sender;
- (void)inputPermission:(id)sender;
- (void)stop:(id)sender;
@end
@implementation GHManager
- (void)refresh:(id)sender {
    const int flags=self.callback(self.context,-1);
    if (flags&128) { [self.window close]; return; }
    self.share.state=(flags&1)?NSControlStateValueOn:NSControlStateValueOff;
    self.control.state=(flags&2)?NSControlStateValueOn:NSControlStateValueOff;
    self.control.enabled=(flags&1)&&(flags&64)&&!(flags&16)&&!(flags&256);
    self.status.stringValue=(flags&16)?@"Input release was not confirmed. Stop Capture and check this Mac.":
        (flags&256)?@"Stopping the session; waiting for resource and input release confirmation.":
        !(flags&32)?@"Capture unavailable. Check Screen Recording permission; restart after granting.":
        (flags&8)?@"Remote control is active. Turn off control to take it back.":
        (flags&4)?@"A client is viewing this display.":
        (flags&1)?@"Sharing enabled. Waiting for a client.":@"Sharing is off. Your desktop is private.";
}
- (void)change:(id)sender {
    int desired=(self.share.state==NSControlStateValueOn)?1:0;
    if (desired && self.control.state==NSControlStateValueOn) desired|=2;
    self.callback(self.context,desired); [self refresh:nil];
}
- (void)recording:(id)sender {
    gh_capture_request_permission(0);
}
- (void)inputPermission:(id)sender {
    gh_capture_request_permission(1);
}
- (void)stop:(id)sender { [self.window close]; }
- (void)windowWillClose:(NSNotification*)notification {
    self.callback(self.context,0); [self.timer invalidate]; [NSApp stop:nil];
    [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0] atStart:NO];
}
@end
int32_t gh_capture_manage(const char* target, gh_policy_cb callback, void* context) {
    @autoreleasepool {
        [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        GHManager* manager=[GHManager new]; manager.callback=callback; manager.context=context;
        manager.window=[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,560,300) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
        manager.window.title=@"GeneHub Capture"; manager.window.delegate=manager; manager.window.releasedWhenClosed=NO;
        NSView* content=manager.window.contentView;
        NSTextField* title=[NSTextField labelWithString:[NSString stringWithFormat:@"Target: %@",[NSString stringWithUTF8String:target?target:""]]];
        title.frame=NSMakeRect(24,250,512,24); [content addSubview:title];
        NSTextField* note=[NSTextField wrappingLabelWithString:@"Sharing exposes this display to clients with GeneHub services access. Control allows those clients to request keyboard and mouse input. No per-device desktop grants are added."];
        note.frame=NSMakeRect(24,180,512,60); [content addSubview:note];
        manager.share=[NSButton checkboxWithTitle:@"Share this display" target:manager action:@selector(change:)]; manager.share.frame=NSMakeRect(24,145,230,24); [content addSubview:manager.share];
        manager.control=[NSButton checkboxWithTitle:@"Allow remote control" target:manager action:@selector(change:)]; manager.control.frame=NSMakeRect(280,145,250,24); [content addSubview:manager.control];
        manager.status=[NSTextField wrappingLabelWithString:@""]; manager.status.frame=NSMakeRect(24,80,512,54); [content addSubview:manager.status];
        NSButton* permission=[NSButton buttonWithTitle:@"Screen permission…" target:manager action:@selector(recording:)]; permission.frame=NSMakeRect(24,24,160,32); [content addSubview:permission];
        NSButton* input=[NSButton buttonWithTitle:@"Input permission…" target:manager action:@selector(inputPermission:)]; input.frame=NSMakeRect(190,24,160,32); [content addSubview:input];
        NSButton* stop=[NSButton buttonWithTitle:@"Stop Capture" target:manager action:@selector(stop:)]; stop.frame=NSMakeRect(380,24,150,32); [content addSubview:stop];
        [manager refresh:nil]; manager.timer=[NSTimer scheduledTimerWithTimeInterval:2 target:manager selector:@selector(refresh:) userInfo:nil repeats:YES];
        [manager.window center]; [manager.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; [NSApp run];
        [manager.timer invalidate]; manager.window.delegate=nil;
    }
    return 0;
}
