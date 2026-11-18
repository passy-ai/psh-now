# dmgbuild settings for the psh notch installer window.
#
# dmgbuild writes the .DS_Store and the icon layout itself, so the window does not
# depend on Finder automation, which macOS may refuse to grant a build shell.
import os

ROOT = os.getcwd()
APP = defines.get("app", os.path.join(ROOT, "dist", "psh notch.app"))

# output path comes from the command line argument
volume_name = "psh notch"
format = "UDZO"
files = [APP]
symlinks = {"Applications": "/Applications"}

# No background image, and that is the point. A painted plate is a fixed colour: draw it
# white and it is a glaring slab to anyone in dark mode, draw it dark and it is a black
# slab to anyone in light mode. Leaving it unset lets Finder draw its own icon-view
# surface, so the window looks like a normal Finder window in whichever appearance the
# person actually uses, and adapts when they switch. It also means there is no bitmap to
# keep in step with the icons.
background = None

window_rect = ((240, 240), (640, 400))
default_view = "icon-view"
# Size to the two icons rather than to the window: at 96 the app icon was noticeably
# smaller than the folder beside it, which reads as a mistake rather than a choice.
icon_size = 128
text_size = 12
icon_locations = {
    "psh notch.app": (170, 200),
    "Applications": (470, 200),
}
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
