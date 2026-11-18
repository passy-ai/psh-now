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

# Same window box as Quotio's (600x400 at 200,248), because the icon positions are read
# against it: 150 and 450 sit evenly in a 600 wide window, and would drift right in a wider one.
window_rect = ((200, 248), (600, 400))
default_view = "icon-view"
# These are not guesses. Quotio's installer - the window this is meant to look like - was
# mounted and its .DS_Store read: iconSize 100, textSize 16, showIconPreview true, icons at
# (150, 190) and (450, 185). Matching them is the difference between "looks like a Finder
# window" and "looks like that window".
icon_size = 100
text_size = 16
show_icon_preview = True
icon_locations = {
    "psh notch.app": (150, 190),
    "Applications": (450, 185),
}
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
