"""Axle and wheel recipes. Kit names (cylinder, cut, join, frame, place, joint, ...) are injected by rumi_joints."""


def wheel(name, pivot, axis, diameter=30, width=10, end_play=0.3, tread=0, standoff=1.0):
    """Make a wheel blank whose inner face sits `standoff + end_play` mm off the mounting face at `pivot`, ready for `captive_axle`.

    `axis` points away from the body. `tread` > 0 adds that many grip ribs.
    """
    part = cylinder(name, diameter / 2, width, (0, 0, standoff + end_play + width / 2), segments=96)
    if tread:
        for index in range(tread):
            rib = box('_rib', (2.4, diameter * 0.12, width - 1.2), (diameter / 2, 0, standoff + end_play + width / 2))
            rotate(rib, 'Z', 360 * index / tread)
            join(part, rib)
    return place(part, frame(pivot, axis))


def captive_axle(parent, child, pivot, axis, width=10, axle_diameter=6, clearance=0.3, end_play=0.3,
                 head_overhang=1.2, head_height=2.5, standoff=1.0, snap=False, recess=True, limits=(-180, 180), control=None, name=None):
    """Mount `child` on a stub axle that grows out of `parent`, held on by an integral head wider than the bore.

    pivot: point on the parent's mounting face where the axle starts. axis: direction pointing away from the parent.
    child: a part whose hub spans standoff + end_play .. standoff + end_play + width along the axis from the pivot
    (see `wheel`). standoff is the thickness of the shoulder washer the recipe adds so the hub bears on a full ring
    even when the parent face is small or uneven.
    snap=True splits and barbs the head so a separately printed wheel pushes on; snap=False leaves a solid head
    for print-in-place. recess=True sinks the head into a counterbore so it does not stand proud of the wheel.
    Returns the revolute joint record.
    """
    radius = axle_diameter / 2
    bore = radius + clearance
    head_radius = bore + head_overhang
    base = standoff + end_play                  # inner face of the hub
    seat = base + width                         # outer face of the hub
    pocket = head_height + end_play if recess else 0
    if recess and width - pocket < 3:
        raise ValueError('captive_axle: width %.1f is too thin for a recessed head; use recess=False or a wider hub' % width)
    stop = seat - pocket                        # face the head bears against
    world = frame(pivot, axis)

    hole = cylinder('_bore', bore, width + 4, (0, 0, base + width / 2))
    cut(child, place(hole, world))
    if recess:
        counterbore = cylinder('_counterbore', head_radius + clearance, pocket + 2, (0, 0, stop + (pocket + 2) / 2))
        cut(child, place(counterbore, world))

    top = stop + end_play
    axle = cylinder('_axle', radius, top + 3, (0, 0, (top - 1) / 2))
    if standoff > 0:
        join(axle, cylinder('_shoulder', head_radius + 2, standoff + 2, (0, 0, (standoff - 2) / 2)))
    lead = min(head_radius - radius, head_height - 0.8) if snap else 0.6
    head = lathe('_head', [(0, top), (head_radius, top), (head_radius, top + head_height - lead),
                           (head_radius - lead, top + head_height), (0, top + head_height)])
    join(axle, head)
    if snap:
        slot = box('_slot', (head_radius * 2 + 2, max(1.6, radius * 0.5), head_height + width * 0.6),
                   (0, 0, top + head_height - (head_height + width * 0.6) / 2 + 0.01))
        cut(axle, slot)
    join(parent, place(axle, world))
    require_one_solid(parent, 'captive_axle', 'Put the pivot on the parent surface so the axle root is embedded in it.')
    return joint(name or child.name + 'Axle', 'revolute', parent, child, direction(axis), pivot, limits, control)
