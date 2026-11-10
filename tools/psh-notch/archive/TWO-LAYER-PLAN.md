# Two layers, not one: the fix for the open/close glitch

## What is wrong today

One window, one black shape, and both `compact` and `list` are states *of that same thing*.
Anything the list does to the panel is therefore done to the idle bar as well. Every patch so far
tried to make the shared thing behave; the bar kept moving or blanking because it was inside the
thing that was changing. They are not one thing. They must not share a window, a shape, or an
animation.

## The two layers

**Layer 1 - the idle bar. Separate window. Never withdraws.**
- 237pt x 32pt at the notch, x = `cutout.midX - width/2`, top flush with the screen top.
- Own window, own black shape, own rounded bottom corners. Created once, shown always, and
  **never resized and never animated** for any reason. It is its own layer: nothing can move it.
- Holds the dot and the count. Grey dot, count at the right, no background behind either.
- With nothing waiting it stays, empty and full width, dot and count hidden.

**Layer 2 - the list. Separate window, its own plugin.**
- Its own borderless transparent window, same x and width, top exactly at the idle bar's bottom.
- Own black shape with rounded bottom corners; its height animates 0 -> its content height.
- Opened when the pointer enters the idle bar. Withdrawn when the pointer leaves the bar and
  the list. Never touches the bar's window, position, or shape in any way.
- Rows: 40pt each, at most 2 visible, the rest scrolled. Risk-colour dot per row, name 13pt,
  age `now/Nm/Nh/Nd/Nw` at the right in 11pt. Last visible row's hover highlight uses the
  bottom-rounded notch path.

## Consequences that make the glitch impossible

- The bar has no animation at all, so there is nothing to glitch. It cannot drift, snap, blank,
  or withdraw, because nothing about it ever changes except the dot's visibility and the number.
- The list window grows and shrinks on its own. If it is late, early, or degenerate for a frame,
  the bar is unaffected: different window, different shape, different layer.
- Both windows keep their height and their top fixed; only the list shape inside layer 2 changes.

## Hover, which is the only link between them

- A tracking area on the bar opens layer 2 on enter.
- Layer 2's own tracking area keeps it open while the pointer is on it.
- It withdraws only when the pointer has left both. Focus of the bar itself never changes:
  it is not hover-dependent and never withdraws.
- `hitTest` returns nil anywhere a layer is not painted, so the transparent canvas of either
  window never steals a click or a hover from what is underneath.

## Order of work

1. Extract the bar into its own window (`IdleBarWindow`), no animation, no resize after creation.
2. Give the list its own window (`ListWindow`) that owns the existing list view and its shape.
3. Wire hover: bar enter -> open list; leave both -> withdraw list.
4. Keep the auto-expand on a request arriving, now openin layer 2 only.
5. Delete the mode-coupled code path that sized one window for both states.
