# dmgbuild settings for the psh notch installer window.
#
# dmgbuild writes the .DS_Store and the background alias itself, so the styled window
# does not depend on Finder automation, which macOS may refuse to grant a build shell.
import os

ROOT = os.getcwd()
APP = defines.get("app", os.path.join(ROOT, "dist", "psh notch.app"))
BG = defines.get("background", os.path.join(ROOT, "dist", "dmg-bg.png"))

# output path comes from the command line argument
volume_name = "psh notch"
format = "UDZO"
files = [APP]
symlinks = {"Applications": "/Applications"}
background = BG
window_rect = ((240, 240), (640, 400))
default_view = "icon-view"
icon_size = 96
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
