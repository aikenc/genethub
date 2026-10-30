#include "capture.h"
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>
namespace {
struct Manager { gh_policy_cb callback; void* context; HWND share,control,status; bool done=false; };
void refresh(Manager* manager) {
    const int flags=manager->callback(manager->context,-1);
    SendMessageW(manager->share,BM_SETCHECK,(flags&1)?BST_CHECKED:BST_UNCHECKED,0);
    SendMessageW(manager->control,BM_SETCHECK,(flags&2)?BST_CHECKED:BST_UNCHECKED,0);
    EnableWindow(manager->control,(flags&1)&&(flags&64)&&!(flags&16)&&!(flags&256));
    SetWindowTextW(manager->status,(flags&16)?L"Input release was not confirmed. Stop Capture and check this PC.":
        (flags&256)?L"Stopping the session; waiting for resource and input release confirmation.":
        !(flags&32)?L"Capture unavailable. Check the desktop, display and encoder.":
        (flags&8)?L"Remote control is active. Turn off control to take it back.":
        (flags&4)?L"A client is viewing this display.":
        (flags&1)?L"Sharing enabled. Waiting for a client.":L"Sharing is off. Your desktop is private.");
}
LRESULT CALLBACK procedure(HWND window,UINT message,WPARAM w,LPARAM l) {
    auto* manager=reinterpret_cast<Manager*>(GetWindowLongPtrW(window,GWLP_USERDATA));
    if (message==WM_NCCREATE) {
        manager=static_cast<Manager*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
        SetWindowLongPtrW(window,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(manager));
    }
    if (!manager) return DefWindowProcW(window,message,w,l);
    if (message==WM_TIMER) { if (manager->callback(manager->context,-1)&128) DestroyWindow(window); else refresh(manager); return 0; }
    if (message==WM_COMMAND && HIWORD(w)==BN_CLICKED) {
        if (LOWORD(w)==3) { DestroyWindow(window); return 0; }
        const int shared=SendMessageW(manager->share,BM_GETCHECK,0,0)==BST_CHECKED?1:0;
        const int control=shared && SendMessageW(manager->control,BM_GETCHECK,0,0)==BST_CHECKED?2:0;
        manager->callback(manager->context,shared|control); refresh(manager); return 0;
    }
    if (message==WM_DESTROY) { KillTimer(window,1); manager->callback(manager->context,0); manager->done=true; return 0; }
    return DefWindowProcW(window,message,w,l);
}
}
int32_t gh_capture_manage(const char* target,gh_policy_cb callback,void* context) {
    Manager manager{callback,context};
    HINSTANCE instance=GetModuleHandleW(nullptr);
    WNDCLASSW klass{}; klass.hInstance=instance; klass.lpfnWndProc=procedure;
    klass.lpszClassName=L"GeneHubCaptureManager"; klass.hCursor=LoadCursorW(nullptr,IDC_ARROW); klass.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_WINDOW+1);
    if (!RegisterClassW(&klass) && GetLastError()!=ERROR_CLASS_ALREADY_EXISTS) return -1;
    HWND window=CreateWindowExW(0,klass.lpszClassName,L"GeneHub Capture",WS_OVERLAPPED|WS_CAPTION|WS_SYSMENU,CW_USEDEFAULT,CW_USEDEFAULT,600,330,nullptr,nullptr,instance,&manager);
    if (!window) return -1;
    auto label=[&](const wchar_t* text,int x,int y,int width,int height) { return CreateWindowExW(0,L"STATIC",text,WS_CHILD|WS_VISIBLE,x,y,width,height,window,nullptr,instance,nullptr); };
    int size=MultiByteToWideChar(CP_UTF8,0,target,-1,nullptr,0); std::wstring title(size,L'\0'); MultiByteToWideChar(CP_UTF8,0,target,-1,title.data(),size);
    label(title.c_str(),24,20,540,28);
    label(L"Sharing exposes this display to clients with GeneHub services access.\nControl lets those clients request keyboard and mouse input.\nNo per-device desktop grants are added.",24,55,540,65);
    manager.share=CreateWindowExW(0,L"BUTTON",L"Share this display",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX,24,130,250,28,window,reinterpret_cast<HMENU>(1),instance,nullptr);
    manager.control=CreateWindowExW(0,L"BUTTON",L"Allow remote control",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX,300,130,260,28,window,reinterpret_cast<HMENU>(2),instance,nullptr);
    manager.status=label(L"",24,175,540,50);
    CreateWindowExW(0,L"BUTTON",L"Stop Capture",WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,400,240,160,32,window,reinterpret_cast<HMENU>(3),instance,nullptr);
    refresh(&manager); SetTimer(window,1,2000,nullptr); ShowWindow(window,SW_SHOW);
    MSG message{};
    while (!manager.done && GetMessageW(&message,nullptr,0,0)>0) { TranslateMessage(&message); DispatchMessageW(&message); }
    if (!manager.done) DestroyWindow(window);
    return 0;
}
