#!/usr/bin/env python3
"""Send real X11 key events (XTEST) so the smoke test exercises Electron's before-input-event.
Usage: xkey.py F12 | xkey.py ctrl+shift+i | xkey.py ctrl+c
Needs: pip install python-xlib. Test tooling only; not shipped in the app."""
import sys, time
from Xlib import X, XK, display
from Xlib.ext import xtest

d = display.Display()
root = d.screen().root
# Put the pointer over the window so PointerRoot focus routes keys to it.
geom = root.get_geometry()
xtest.fake_input(d, X.MotionNotify, x=geom.width // 2, y=geom.height // 2)
d.sync()
time.sleep(0.2)

def keycode(name):
    sym = XK.string_to_keysym(name) or XK.string_to_keysym(name.upper()) or XK.string_to_keysym(name.capitalize())
    return d.keysym_to_keycode(sym)

MODS = {'ctrl': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L'}
parts = sys.argv[1].split('+')
mods, key = [MODS[p.lower()] for p in parts[:-1]], parts[-1]
for m in mods:
    xtest.fake_input(d, X.KeyPress, keycode(m))
xtest.fake_input(d, X.KeyPress, keycode(key))
xtest.fake_input(d, X.KeyRelease, keycode(key))
for m in reversed(mods):
    xtest.fake_input(d, X.KeyRelease, keycode(m))
d.sync()
