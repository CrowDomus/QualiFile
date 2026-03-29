from __future__ import annotations

import ctypes
from ctypes import wintypes
import sys


class Win32ApiError(RuntimeError):
    def __init__(self, message: str, code: int | None = None, details: str | None = None) -> None:
        if code is None and sys.platform == "win32":
            code = last_error_code()
        if details is None and code:
            details = format_last_error(code)
        self.code = code
        self.details = details
        full = message
        if code:
            full = f"{message} (win32 error {code}: {details})"
        super().__init__(full)


if sys.platform == "win32":
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    comctl32 = ctypes.WinDLL("comctl32", use_last_error=True)
    uxtheme = ctypes.WinDLL("uxtheme", use_last_error=True)
else:
    user32 = None
    kernel32 = None
    gdi32 = None
    comctl32 = None
    uxtheme = None


def _require_win32() -> None:
    if sys.platform != "win32":
        raise Win32ApiError("Win32 APIs are only available on Windows.")
    _init_prototypes_once()


if hasattr(wintypes, "LRESULT"):
    LRESULT = wintypes.LRESULT
else:
    LRESULT = ctypes.c_longlong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_long

UINT_PTR = ctypes.c_uint64 if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_uint32

HGLOBAL = getattr(wintypes, "HGLOBAL", wintypes.HANDLE)
HCURSOR = getattr(wintypes, "HCURSOR", wintypes.HANDLE)
HICON = getattr(wintypes, "HICON", wintypes.HANDLE)
HBRUSH = getattr(wintypes, "HBRUSH", wintypes.HANDLE)
HINSTANCE = getattr(wintypes, "HINSTANCE", wintypes.HANDLE)
HMENU = getattr(wintypes, "HMENU", wintypes.HANDLE)
HFONT = getattr(wintypes, "HFONT", wintypes.HANDLE)
HGDIOBJ = getattr(wintypes, "HGDIOBJ", wintypes.HANDLE)
HRGN = getattr(wintypes, "HRGN", wintypes.HANDLE)

WNDPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


class WNDCLASSEXW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.UINT),
        ("style", wintypes.UINT),
        ("lpfnWndProc", WNDPROC),
        ("cbClsExtra", ctypes.c_int),
        ("cbWndExtra", ctypes.c_int),
        ("hInstance", HINSTANCE),
        ("hIcon", HICON),
        ("hCursor", HCURSOR),
        ("hbrBackground", HBRUSH),
        ("lpszMenuName", wintypes.LPCWSTR),
        ("lpszClassName", wintypes.LPCWSTR),
        ("hIconSm", HICON),
    ]


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", wintypes.POINT),
    ]


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class INITCOMMONCONTROLSEX(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("dwICC", wintypes.DWORD)]


CS_HREDRAW = 0x0002
CS_VREDRAW = 0x0001

CW_USEDEFAULT = 0x80000000

WS_OVERLAPPEDWINDOW = 0x00CF0000
WS_VISIBLE = 0x10000000
WS_CHILD = 0x40000000
WS_TABSTOP = 0x00010000
WS_CLIPSIBLINGS = 0x04000000
WS_EX_CLIENTEDGE = 0x00000200
WS_MAXIMIZEBOX = 0x00010000
WS_THICKFRAME = 0x00040000

BS_PUSHBUTTON = 0x00000000
BS_DEFPUSHBUTTON = 0x00000001
BS_AUTOCHECKBOX = 0x00000003

ES_MULTILINE = 0x0004
ES_AUTOVSCROLL = 0x0040
ES_READONLY = 0x0800
ES_WANTRETURN = 0x1000

EM_SETSEL = 0x00B1
EM_REPLACESEL = 0x00C2

CBS_DROPDOWNLIST = 0x0003
CBS_HASSTRINGS = 0x0200

LBS_NOTIFY = 0x0001

SS_ICON = 0x00000003

LB_ADDSTRING = 0x0180
LB_RESETCONTENT = 0x0184
CB_ADDSTRING = 0x0143
CB_RESETCONTENT = 0x014B
CB_SETCURSEL = 0x014E
CB_GETCURSEL = 0x0147
BM_GETCHECK = 0x00F0
BM_SETCHECK = 0x00F1

WM_CREATE = 0x0001
WM_DESTROY = 0x0002
WM_CLOSE = 0x0010
WM_COMMAND = 0x0111
WM_TIMER = 0x0113
WM_SIZE = 0x0005
WM_SETFONT = 0x0030
WM_SETICON = 0x0080
WM_CTLCOLORSTATIC = 0x0138

SW_SHOW = 5
SW_HIDE = 0

MB_YESNO = 0x00000004
MB_ICONQUESTION = 0x00000020
MB_DEFBUTTON2 = 0x00000100
MB_OK = 0x00000000
MB_ICONERROR = 0x00000010
IDYES = 6

CF_UNICODETEXT = 13

PBS_MARQUEE = 0x08
PBM_SETMARQUEE = 0x040A
PBM_SETBARCOLOR = 0x0409

ICC_PROGRESS_CLASS = 0x00000020
BST_CHECKED = 1
ICON_SMALL = 0
ICON_BIG = 1
IMAGE_ICON = 1
STM_SETIMAGE = 0x0172
LOGPIXELSX = 88
DEFAULT_GUI_FONT = 17

FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000
FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200

RDW_INVALIDATE = 0x0001
RDW_INTERNALPAINT = 0x0002
RDW_ERASE = 0x0004
RDW_VALIDATE = 0x0008
RDW_ALLCHILDREN = 0x0080
RDW_UPDATENOW = 0x0100

_PROTOTYPES_INITIALIZED = False


def _init_prototypes_once() -> None:
    global _PROTOTYPES_INITIALIZED
    if _PROTOTYPES_INITIALIZED or sys.platform != "win32":
        return

    user32.RegisterClassExW.restype = wintypes.ATOM
    user32.RegisterClassExW.argtypes = [ctypes.POINTER(WNDCLASSEXW)]

    user32.CreateWindowExW.restype = wintypes.HWND
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCWSTR,
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.HWND,
        HMENU,
        HINSTANCE,
        wintypes.LPVOID,
    ]

    user32.DefWindowProcW.restype = LRESULT
    user32.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.GetMessageW.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [ctypes.POINTER(MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
    user32.TranslateMessage.restype = wintypes.BOOL
    user32.TranslateMessage.argtypes = [ctypes.POINTER(MSG)]
    user32.DispatchMessageW.restype = LRESULT
    user32.DispatchMessageW.argtypes = [ctypes.POINTER(MSG)]

    user32.ShowWindow.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.UpdateWindow.restype = wintypes.BOOL
    user32.UpdateWindow.argtypes = [wintypes.HWND]
    user32.EnableWindow.restype = wintypes.BOOL
    user32.EnableWindow.argtypes = [wintypes.HWND, wintypes.BOOL]
    user32.SetWindowTextW.restype = wintypes.BOOL
    user32.SetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]

    user32.SendMessageW.restype = LRESULT
    user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    user32.GetClientRect.restype = wintypes.BOOL
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
    user32.MoveWindow.restype = wintypes.BOOL
    user32.MoveWindow.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.BOOL]
    user32.InvalidateRect.restype = wintypes.BOOL
    user32.InvalidateRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT), wintypes.BOOL]
    user32.RedrawWindow.restype = wintypes.BOOL
    user32.RedrawWindow.argtypes = [wintypes.HWND, ctypes.POINTER(RECT), HRGN, wintypes.UINT]
    user32.DestroyWindow.restype = wintypes.BOOL
    user32.DestroyWindow.argtypes = [wintypes.HWND]
    user32.PostMessageW.restype = wintypes.BOOL
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]

    user32.SetTimer.restype = UINT_PTR
    user32.SetTimer.argtypes = [wintypes.HWND, UINT_PTR, wintypes.UINT, wintypes.LPVOID]
    user32.KillTimer.restype = wintypes.BOOL
    user32.KillTimer.argtypes = [wintypes.HWND, UINT_PTR]
    user32.PostQuitMessage.argtypes = [ctypes.c_int]

    user32.LoadCursorW.restype = HCURSOR
    user32.LoadCursorW.argtypes = [HINSTANCE, wintypes.LPCWSTR]
    user32.LoadIconW.restype = HICON
    user32.LoadIconW.argtypes = [HINSTANCE, wintypes.LPCWSTR]
    user32.MessageBoxW.restype = ctypes.c_int
    user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]

    user32.OpenClipboard.restype = wintypes.BOOL
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.CloseClipboard.argtypes = []
    user32.SetClipboardData.restype = wintypes.HANDLE
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]

    user32.GetDC.restype = wintypes.HDC
    user32.GetDC.argtypes = [wintypes.HWND]
    user32.ReleaseDC.restype = ctypes.c_int
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]

    if hasattr(user32, "GetDpiForWindow"):
        user32.GetDpiForWindow.restype = wintypes.UINT
        user32.GetDpiForWindow.argtypes = [wintypes.HWND]

    kernel32.GetModuleHandleW.restype = HINSTANCE
    kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel32.GlobalAlloc.restype = HGLOBAL
    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalLock.argtypes = [HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    kernel32.GlobalUnlock.argtypes = [HGLOBAL]
    kernel32.FormatMessageW.restype = wintypes.DWORD
    kernel32.FormatMessageW.argtypes = [
        wintypes.DWORD,
        wintypes.LPCVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPWSTR,
        wintypes.DWORD,
        wintypes.LPVOID,
    ]

    gdi32.GetDeviceCaps.restype = ctypes.c_int
    gdi32.GetDeviceCaps.argtypes = [wintypes.HDC, ctypes.c_int]
    gdi32.CreateFontW.restype = HFONT
    gdi32.CreateFontW.argtypes = [
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPCWSTR,
    ]
    gdi32.DeleteObject.restype = wintypes.BOOL
    gdi32.DeleteObject.argtypes = [HGDIOBJ]
    gdi32.CreateSolidBrush.restype = HBRUSH
    gdi32.CreateSolidBrush.argtypes = [wintypes.COLORREF]
    gdi32.SetTextColor.restype = wintypes.COLORREF
    gdi32.SetTextColor.argtypes = [wintypes.HDC, wintypes.COLORREF]
    gdi32.SetBkColor.restype = wintypes.COLORREF
    gdi32.SetBkColor.argtypes = [wintypes.HDC, wintypes.COLORREF]

    comctl32.InitCommonControlsEx.restype = wintypes.BOOL
    comctl32.InitCommonControlsEx.argtypes = [ctypes.POINTER(INITCOMMONCONTROLSEX)]

    if uxtheme is not None and hasattr(uxtheme, "SetWindowTheme"):
        uxtheme.SetWindowTheme.restype = ctypes.c_long
        uxtheme.SetWindowTheme.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR]

    _PROTOTYPES_INITIALIZED = True


def last_error_code() -> int:
    if sys.platform != "win32":
        return 0
    return int(ctypes.get_last_error())


def format_last_error(code: int) -> str:
    if sys.platform != "win32":
        return "Win32 APIs are only available on Windows."
    if not code:
        return "No error."
    buffer = ctypes.create_unicode_buffer(512)
    flags = FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS
    length = kernel32.FormatMessageW(flags, None, code, 0, buffer, len(buffer), None)
    if length:
        return buffer.value.strip()
    return f"Unknown error {code}."


def last_error_message() -> str:
    return format_last_error(last_error_code())


def init_common_controls() -> None:
    _require_win32()
    icc = INITCOMMONCONTROLSEX()
    icc.dwSize = ctypes.sizeof(INITCOMMONCONTROLSEX)
    icc.dwICC = ICC_PROGRESS_CLASS
    comctl32.InitCommonControlsEx(ctypes.byref(icc))


def get_module_handle() -> HINSTANCE:
    _require_win32()
    return kernel32.GetModuleHandleW(None)


def load_cursor() -> HCURSOR:
    _require_win32()
    user32.LoadCursorW.restype = HCURSOR
    user32.LoadCursorW.argtypes = [HINSTANCE, wintypes.LPCWSTR]
    return user32.LoadCursorW(None, ctypes.c_wchar_p(32512))


def load_app_icon() -> HICON:
    _require_win32()
    user32.LoadIconW.restype = HICON
    user32.LoadIconW.argtypes = [HINSTANCE, wintypes.LPCWSTR]
    icon = user32.LoadIconW(get_module_handle(), ctypes.c_wchar_p(1))
    if icon:
        return icon
    return user32.LoadIconW(None, ctypes.c_wchar_p(32512))


def register_class(class_name: str, wnd_proc: WNDPROC) -> int:
    _require_win32()
    wnd_class = WNDCLASSEXW()
    wnd_class.cbSize = ctypes.sizeof(WNDCLASSEXW)
    wnd_class.style = CS_HREDRAW | CS_VREDRAW
    wnd_class.lpfnWndProc = wnd_proc
    wnd_class.cbClsExtra = 0
    wnd_class.cbWndExtra = 0
    wnd_class.hInstance = get_module_handle()
    wnd_class.hIcon = load_app_icon()
    wnd_class.hCursor = load_cursor()
    wnd_class.hbrBackground = ctypes.c_void_p(5)
    wnd_class.lpszMenuName = None
    wnd_class.lpszClassName = class_name
    wnd_class.hIconSm = wnd_class.hIcon
    atom = user32.RegisterClassExW(ctypes.byref(wnd_class))
    if not atom:
        raise Win32ApiError("RegisterClassExW failed.")
    return atom


def create_window(
    class_name: str,
    title: str,
    style: int,
    ex_style: int,
    x: int,
    y: int,
    width: int,
    height: int,
    parent: wintypes.HWND | None = None,
    menu: HMENU | None = None,
) -> wintypes.HWND:
    _require_win32()
    hwnd = user32.CreateWindowExW(
        ex_style,
        class_name,
        title,
        style,
        x,
        y,
        width,
        height,
        parent,
        menu,
        get_module_handle(),
        None,
    )
    if not hwnd:
        raise Win32ApiError("CreateWindowExW failed.")
    return hwnd


def message_loop():
    _require_win32()
    msg = MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))


def def_window_proc(hwnd, msg, wparam, lparam):
    _require_win32()
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)


def show_window(hwnd: wintypes.HWND, show_cmd: int) -> None:
    _require_win32()
    user32.ShowWindow(hwnd, show_cmd)
    user32.UpdateWindow(hwnd)


def update_window(hwnd: wintypes.HWND) -> None:
    _require_win32()
    user32.UpdateWindow(hwnd)


def post_quit_message() -> None:
    _require_win32()
    user32.PostQuitMessage(0)


def destroy_window(hwnd: wintypes.HWND) -> None:
    _require_win32()
    user32.DestroyWindow(hwnd)


def post_message(hwnd: wintypes.HWND, msg: int, wparam: int = 0, lparam: int = 0) -> None:
    _require_win32()
    user32.PostMessageW(hwnd, msg, wparam, lparam)


def invalidate_rect(hwnd: wintypes.HWND) -> None:
    _require_win32()
    user32.InvalidateRect(hwnd, None, True)


def redraw_window(hwnd: wintypes.HWND, flags: int) -> None:
    _require_win32()
    user32.RedrawWindow(hwnd, None, None, flags)


def set_timer(hwnd: wintypes.HWND, timer_id: int, interval_ms: int) -> None:
    _require_win32()
    user32.SetTimer(hwnd, timer_id, interval_ms, None)


def kill_timer(hwnd: wintypes.HWND, timer_id: int) -> None:
    _require_win32()
    user32.KillTimer(hwnd, timer_id)


def get_client_rect(hwnd: wintypes.HWND) -> tuple[bool, RECT]:
    _require_win32()
    rect = RECT()
    ok = bool(user32.GetClientRect(hwnd, ctypes.byref(rect)))
    return ok, rect


def get_window_rect(hwnd: wintypes.HWND) -> tuple[bool, RECT]:
    _require_win32()
    rect = RECT()
    ok = bool(user32.GetWindowRect(hwnd, ctypes.byref(rect)))
    return ok, rect


def move_window(hwnd: wintypes.HWND, x: int, y: int, width: int, height: int, log_once_key: str | None = None) -> tuple[bool, str | None]:
    _require_win32()
    ok = bool(user32.MoveWindow(hwnd, x, y, width, height, True))
    if ok:
        return True, None
    return False, last_error_message()


def set_text(hwnd: wintypes.HWND, text: str) -> None:
    _require_win32()
    user32.SetWindowTextW(hwnd, text)


def enable_window(hwnd: wintypes.HWND, enabled: bool) -> None:
    _require_win32()
    user32.EnableWindow(hwnd, 1 if enabled else 0)


def show_control(hwnd: wintypes.HWND, visible: bool) -> None:
    _require_win32()
    user32.ShowWindow(hwnd, SW_SHOW if visible else SW_HIDE)


def send_message(hwnd: wintypes.HWND, msg: int, wparam: int, lparam: int) -> int:
    _require_win32()
    lp = lparam
    if isinstance(lparam, (ctypes.c_wchar_p, ctypes.c_char_p, ctypes.Array, ctypes._Pointer)):
        addr = ctypes.cast(lparam, ctypes.c_void_p).value or 0
        lp = wintypes.LPARAM(addr)
    return user32.SendMessageW(hwnd, msg, wparam, lp)


def set_window_icons(hwnd: wintypes.HWND, icon: HICON | None = None) -> None:
    _require_win32()
    icon_handle = icon or load_app_icon()
    if not icon_handle:
        return
    send_message(hwnd, WM_SETICON, ICON_BIG, icon_handle)
    send_message(hwnd, WM_SETICON, ICON_SMALL, icon_handle)


def set_control_icon(hwnd: wintypes.HWND, icon: HICON | None = None) -> None:
    _require_win32()
    icon_handle = icon or load_app_icon()
    if not icon_handle:
        return
    send_message(hwnd, STM_SETIMAGE, IMAGE_ICON, icon_handle)


def message_box(hwnd: wintypes.HWND, text: str, title: str, flags: int) -> int:
    _require_win32()
    return user32.MessageBoxW(hwnd, text, title, flags)


def open_clipboard(hwnd: wintypes.HWND | None = None) -> bool:
    _require_win32()
    return bool(user32.OpenClipboard(hwnd))


def empty_clipboard() -> None:
    _require_win32()
    user32.EmptyClipboard()


def close_clipboard() -> None:
    _require_win32()
    user32.CloseClipboard()


def set_clipboard_text(text: str) -> None:
    _require_win32()
    if not open_clipboard(None):
        return
    try:
        empty_clipboard()
        data = ctypes.create_unicode_buffer(text)
        handle = kernel32.GlobalAlloc(0x0002, ctypes.sizeof(data))
        if not handle:
            return
        locked = kernel32.GlobalLock(handle)
        if not locked:
            return
        ctypes.memmove(locked, data, ctypes.sizeof(data))
        kernel32.GlobalUnlock(handle)
        user32.SetClipboardData(CF_UNICODETEXT, handle)
    finally:
        close_clipboard()


def create_font(name: str = "Segoe UI", size_pt: int = 9, weight: int = 400) -> HFONT:
    _require_win32()
    hdc = user32.GetDC(None)
    try:
        dpi = gdi32.GetDeviceCaps(hdc, LOGPIXELSX) if hdc else 96
    finally:
        if hdc:
            user32.ReleaseDC(None, hdc)
    height = -int(size_pt * dpi / 72)
    return gdi32.CreateFontW(
        height,
        0,
        0,
        0,
        weight,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        name,
    )


def apply_font(hwnd: wintypes.HWND, font: HFONT) -> None:
    _require_win32()
    send_message(hwnd, WM_SETFONT, font, 1)


def delete_object(handle: HGDIOBJ | None) -> None:
    _require_win32()
    if not handle:
        return
    gdi32.DeleteObject(handle)


def create_solid_brush(color_ref: int) -> HBRUSH:
    _require_win32()
    return gdi32.CreateSolidBrush(color_ref)


def set_dc_text_color(hdc: wintypes.HDC, color_ref: int) -> None:
    _require_win32()
    gdi32.SetTextColor(hdc, color_ref)


def set_dc_bk_color(hdc: wintypes.HDC, color_ref: int) -> None:
    _require_win32()
    gdi32.SetBkColor(hdc, color_ref)


def get_dpi_for_window(hwnd: wintypes.HWND | None = None) -> int:
    _require_win32()
    if hasattr(user32, "GetDpiForWindow") and hwnd:
        try:
            return int(user32.GetDpiForWindow(hwnd))
        except Exception:
            pass
    hdc = user32.GetDC(hwnd or None)
    try:
        return int(gdi32.GetDeviceCaps(hdc, LOGPIXELSX)) if hdc else 96
    finally:
        if hdc:
            user32.ReleaseDC(hwnd or None, hdc)


def set_window_theme(hwnd: wintypes.HWND, theme: str = "Explorer") -> None:
    _require_win32()
    if uxtheme is None or not hasattr(uxtheme, "SetWindowTheme"):
        return
    try:
        uxtheme.SetWindowTheme(hwnd, theme, None)
    except Exception:
        return
