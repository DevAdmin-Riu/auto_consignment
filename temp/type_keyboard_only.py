"""
Interception 키보드 전용 타이핑 스크립트 (상주 모드 지원)
- 키보드 디바이스(device 0)만 열어서 마우스는 절대 안 건드림
- 이 스크립트는 ctypes로 키보드 디바이스 1개만 직접 제어
- SET_FILTER, SET_EVENT 사용 안함 (마우스 먹통 방지)

사용법:
  단발 입력:  python type_keyboard_only.py <device_num> <text>
  특수 키:   python type_keyboard_only.py <device_num> ENTER --key
  상주 모드:  python type_keyboard_only.py <device_num> --pipe
             (stdin으로 텍스트를 줄 단위로 보내면 입력, EOF로 종료)
"""
import ctypes
import struct
import sys
import time

# Windows constants
GENERIC_READ = 0x80000000
OPEN_EXISTING = 3
FILE_DEVICE_UNKNOWN = 0x00000022
METHOD_BUFFERED = 0
FILE_ANY_ACCESS = 0

def ctl(device_type, function_code, method, access):
    return (device_type << 16) | (access << 14) | (function_code << 2) | method

IOCTL_WRITE = ctl(FILE_DEVICE_UNKNOWN, 0x820, METHOD_BUFFERED, FILE_ANY_ACCESS)

# Key flags
KEY_DOWN = 0x00
KEY_UP = 0x01

# 특수 키 scan code 매핑
SPECIAL_KEYS = {
    'ENTER': 0x1C,
    'ESCAPE': 0x01,
    'ESC': 0x01,
    'TAB': 0x0F,
    'BACKSPACE': 0x0E,
    'SPACE': 0x39,
    'UP': 0x48,
    'DOWN': 0x50,
    'LEFT': 0x4B,
    'RIGHT': 0x4D,
}

# VK to Scan code mapping
MapVirtualKeyA = ctypes.windll.user32.MapVirtualKeyA
VkKeyScanA = ctypes.windll.user32.VkKeyScanA

def get_scan_code(char):
    vk_result = VkKeyScanA(ord(char))
    if vk_result == -1:
        return None, False
    vk_code = vk_result & 0xFF
    shift = bool(vk_result & 0x100)
    scan_code = MapVirtualKeyA(vk_code, 0)
    return scan_code, shift

def make_keystroke(scan_code, flags=KEY_DOWN):
    return struct.pack('HHHHI', 0, scan_code, flags, 0, 0)

def open_keyboard_device(device_num):
    device_name = f"\\\\.\\interception{device_num:02d}".encode()
    handle = ctypes.windll.kernel32.CreateFileA(
        device_name, GENERIC_READ, 0, 0, OPEN_EXISTING, 0, 0
    )
    if handle == -1:
        raise Exception(f"Failed to open device {device_num}")
    return handle

def send_keystroke(handle, stroke_data):
    buf = (ctypes.c_ubyte * 12)(*stroke_data)
    bytes_returned = (ctypes.c_uint32 * 1)(0)
    return ctypes.windll.kernel32.DeviceIoControl(
        handle, IOCTL_WRITE, buf, 12, None, 0, bytes_returned, None
    )

def type_text_with_handle(handle, text):
    """핸들을 받아서 텍스트 입력 (핸들 열기/닫기 안함)"""
    SHIFT_SCAN = MapVirtualKeyA(0x10, 0)

    for char in text:
        scan_code, need_shift = get_scan_code(char)
        if scan_code is None:
            continue

        if need_shift:
            send_keystroke(handle, make_keystroke(SHIFT_SCAN, KEY_DOWN))
            time.sleep(0.02)

        send_keystroke(handle, make_keystroke(scan_code, KEY_DOWN))
        time.sleep(0.02)
        send_keystroke(handle, make_keystroke(scan_code, KEY_UP))

        if need_shift:
            time.sleep(0.02)
            send_keystroke(handle, make_keystroke(SHIFT_SCAN, KEY_UP))

        time.sleep(0.08)

def press_key_with_handle(handle, key_name):
    """핸들을 받아서 특수 키 입력"""
    key_upper = key_name.upper()
    if key_upper not in SPECIAL_KEYS:
        return False
    scan_code = SPECIAL_KEYS[key_upper]
    send_keystroke(handle, make_keystroke(scan_code, KEY_DOWN))
    time.sleep(0.02)
    send_keystroke(handle, make_keystroke(scan_code, KEY_UP))
    time.sleep(0.05)
    return True

def run_pipe_mode(device_num):
    """상주 모드: stdin에서 명령을 줄 단위로 받아 실행. 핸들 1회만 열고 닫음."""
    handle = open_keyboard_device(device_num)
    sys.stdout.write("READY\n")
    sys.stdout.flush()

    try:
        for line in sys.stdin:
            cmd = line.strip()
            if not cmd:
                continue

            if cmd.startswith("KEY:"):
                key_name = cmd[4:]
                press_key_with_handle(handle, key_name)
            else:
                type_text_with_handle(handle, cmd)

            sys.stdout.write("OK\n")
            sys.stdout.flush()
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)

# === 단발 모드 호환 함수 ===
def type_text(device_num, text):
    handle = open_keyboard_device(device_num)
    try:
        type_text_with_handle(handle, text)
        print('OK')
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)

def press_key(device_num, key_name):
    handle = open_keyboard_device(device_num)
    try:
        if press_key_with_handle(handle, key_name):
            print('OK')
        else:
            print(f"Unknown key: {key_name}")
            sys.exit(1)
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python type_keyboard_only.py <device_num> <text>")
        print("       python type_keyboard_only.py <device_num> --pipe")
        sys.exit(1)

    device_num = int(sys.argv[1])

    if sys.argv[2] == '--pipe':
        run_pipe_mode(device_num)
    elif len(sys.argv) >= 4 and sys.argv[3] == '--key':
        press_key(device_num, sys.argv[2])
    else:
        type_text(device_num, sys.argv[2])
