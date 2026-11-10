"""Slider recipes: dovetail, T-slot, telescoping tube and pin in a slot. Kit names (cylinder, cut, join, frame, place, joint, ...) are injected by rumi_joints.

Calling convention shared by every recipe here: `parent` holds the rail, slot or tube and is the held part; `child` is the part that
moves. `pivot` is a point on the parent's surface at the centre of the child's travel. `axis` is the direction the child slides (the
joint axis). `up` is the direction pointing out of the parent's surface toward the child. `travel` is the total stroke in mm,
centred on the saved pose, and the recipe's end stops sit 0.5 mm beyond each end of it.
"""

_STOP_GAP = 0.5


def _extent(obj, world):
    """Return [(low, high)] of the part along the local X, Y and Z of `world`, in millimetres."""
    inverse = world.inverted()
    points = [inverse @ (vertex.co / MM) for vertex in obj.data.vertices]
    return [(min(p[i] for p in points), max(p[i] for p in points)) for i in range(3)]


def _frame(recipe, pivot, axis, up):
    if abs(direction(axis).dot(direction(up))) > 1e-3:
        raise ValueError('%s: axis (the sliding direction) and up (out of the parent surface) must be perpendicular' % recipe)
    return frame(pivot, up, axis)


def _lift_child(child, world, clearance):
    """Trim the child's underside to three clearances above the parent surface.

    The child then never rests on the parent's face while the slider or rail carries it; a slotted or grooved bearing face makes the
    validator report a false deep penetration.
    """
    lift = 3 * clearance
    cut(child, place(box2('_below', (-500, -500, -500), (500, 500, lift)), world))


def _stadium(radius, half, low, high):
    """Slot outline (two circles `half` mm either side of the origin joined by flats) extruded along Z from `low` to `high`."""
    points = []
    steps = 24
    for i in range(steps + 1):
        angle = -math.pi / 2 + math.pi * i / steps
        points.append((half + radius * math.cos(angle), radius * math.sin(angle)))
    for i in range(steps + 1):
        angle = math.pi / 2 + math.pi * i / steps
        points.append((-half + radius * math.cos(angle), radius * math.sin(angle)))
    return prism('_stadium', points, high - low, (0, 0, (low + high) / 2))


def _volume(obj):
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    volume = mesh.calc_volume()
    mesh.free()
    return volume


def _cut(recipe, target, tool):
    """Cut `tool` out of `target`, and fail loudly if the boolean did nothing or added material."""
    tool_volume = _volume(tool)
    before = _volume(target)
    cut(target, tool)
    after = _volume(target)
    if not 0 < before - after < 1.001 * tool_volume:
        raise ValueError('%s: the cut in %s failed to remove the expected volume; change a size by 0.1 mm and try again' % (recipe, target.name))


def _check_surface(recipe, parent, world):
    """The parent's top must be at the pivot, since every recipe measures from there."""
    top = _extent(parent, world)[2][1]
    if abs(top) > 0.5:
        raise ValueError('%s: the parent surface is %.1f mm from the pivot along up; put the pivot on that surface' % (recipe, top))


def dovetail_slide(parent, child, pivot, axis, up, travel=30, length=16, stem_width=6, head_width=10, head_height=5, neck_depth=3,
                   clearance=0.35, neck_clearance=1.0, limits=None, control=None, name=None):
    """A dovetail-shaped key sliding in a dovetail groove cut into `parent`. The groove is closed at both ends, so the key never leaves.

    The groove narrows from the bottom to `head_width` at the top of the chamber (flanks lean 30 degrees from vertical, 60 degrees
    included) and the key fills it, so the flanks lock it in. parent: a solid block at the pivot, deep enough (neck_depth + head_height +
    2 * clearance + 1.5 mm below the surface), wider than the groove's bottom (head_width + 1.155 * head_height + 2 * clearance + 3 mm)
    and longer than the slot (length + travel + 1 mm, plus 3 mm). child: a block above the groove, whose underside is trimmed to
    3 * `clearance` above the parent; the recipe fuses the key and stem to it. length: the key's length along axis. stem_width: the neck
    through the groove mouth, `neck_clearance` looser than the key's flanks. It prints in place (parent upright, groove walls at 30
    degrees from vertical). Returns the prismatic joint record; limits default to (-travel / 2, travel / 2).
    """
    world = _frame('dovetail_slide', pivot, axis, up)
    slope = 0.57735
    chamber = head_height + 2 * clearance
    slot_half = length / 2 + travel / 2 + _STOP_GAP
    neck = stem_width / 2 + neck_clearance
    top = head_width / 2 + clearance
    bottom = top + chamber * slope
    _check_surface('dovetail_slide', parent, world)
    (x_low, x_high), (y_low, y_high), (z_low, _) = _extent(parent, world)
    needs = (neck_depth + chamber + 1.5, bottom + 1.5, slot_half + 1.5)
    if neck >= top or -z_low < needs[0] or min(-y_low, y_high) < needs[1] or min(-x_low, x_high) < needs[2]:
        raise ValueError('dovetail_slide: the parent must reach %.1f mm below the pivot, %.1f mm either side of the groove and %.1f mm either way along it; it reaches %.1f, %.1f and %.1f (and stem_width + 2 * neck_clearance must be under head_width)'
                         % (needs[0], needs[1], needs[2], -z_low, min(-y_low, y_high), min(-x_low, x_high)))
    (_, child_top) = _extent(child, world)[2]
    if child_top < 3 * clearance + 3:
        raise ValueError('dovetail_slide: the child must reach at least %.1f mm above the parent surface' % (3 * clearance + 3))

    groove = prism('_groove', [(-neck, 1), (neck, 1), (neck, -neck_depth), (top, -neck_depth), (bottom, -neck_depth - chamber),
                               (-bottom, -neck_depth - chamber), (-top, -neck_depth), (-neck, -neck_depth)],
                   2 * slot_half, (0, 0, 0), 'X', 'Y')
    _cut('dovetail_slide', parent, place(groove, world))
    require_one_solid(parent, 'dovetail_slide', 'The groove split the parent; make it thicker or wider around the groove.')

    _lift_child(child, world, clearance)
    # The key is the groove shrunk by one clearance, measured square to the flanks.
    inset = clearance / 0.866025
    key_top = -neck_depth - clearance
    key_bottom = -neck_depth - chamber + clearance
    half_top = top + clearance * slope - inset
    half_bottom = top + (chamber - clearance) * slope - inset
    key = prism('_key', [(-half_top, key_top), (half_top, key_top), (half_bottom, key_bottom), (-half_bottom, key_bottom)],
                length, (0, 0, 0), 'X', 'Y')
    join(key, prism('_stem', [(-stem_width / 2, key_top - 1), (stem_width / 2, key_top - 1), (stem_width / 2, 3 * clearance + 1), (-stem_width / 2, 3 * clearance + 1)],
                    length - 2, (0, 0, 0), 'X', 'Y'))
    join(child, place(key, world))
    require_one_solid(child, 'dovetail_slide', 'The stem must overlap the child; make the child cover the groove at the pivot.')
    return joint(name or child.name + 'Slide', 'prismatic', parent, child, direction(axis), pivot,
                 limits if limits is not None else (-travel / 2, travel / 2), control)


def tslot_rail(parent, child, pivot, axis, up, travel=30, length=16, stem_width=6, head_width=12, head_height=4, neck_depth=3,
               clearance=0.35, neck_clearance=1.0, limits=None, control=None, name=None):
    """A T-shaped slider in a T-slot cut into `parent`. The slot is closed at both ends, so the slider can never leave.

    parent: a solid block at the pivot, deep enough for the slot (neck_depth + head_height + 2 * clearance + 1.5 mm below the surface), at
    least head_width + 2 * clearance + 3 mm wide, and long enough for the slot (length + travel + 1 mm, plus 3 mm). child: a block above
    the slot, whose underside is trimmed to 3 * `clearance` above the parent; the recipe fuses the stem and head onto it.
    length: how long the stem and head are along axis. stem_width / head_width: the neck and the wider head. neck_depth: thickness of the
    shoulder over the head. neck_clearance: the looser side gap round the stem. The slider prints in place inside the closed slot
    (print the parent upright, the shoulder bridges).
    Returns the prismatic joint record; limits default to (-travel / 2, travel / 2).
    """
    world = _frame('tslot_rail', pivot, axis, up)
    chamber = head_height + 2 * clearance
    slot_half = length / 2 + travel / 2 + _STOP_GAP
    neck = stem_width / 2 + neck_clearance
    wide = head_width / 2 + clearance
    _check_surface('tslot_rail', parent, world)
    (x_low, x_high), (y_low, y_high), (z_low, _) = _extent(parent, world)
    needs = (neck_depth + chamber + 1.5, wide + 1.5, slot_half + 1.5)
    if -z_low < needs[0] or min(-y_low, y_high) < needs[1] or min(-x_low, x_high) < needs[2]:
        raise ValueError('tslot_rail: the parent must reach %.1f mm below the pivot, %.1f mm either side of the slot and %.1f mm either way along it; it reaches %.1f, %.1f and %.1f'
                         % (needs[0], needs[1], needs[2], -z_low, min(-y_low, y_high), min(-x_low, x_high)))
    (_, top) = _extent(child, world)[2]
    if top < 3 * clearance + 3:
        raise ValueError('tslot_rail: the child must reach at least %.1f mm above the parent surface' % (3 * clearance + 3))

    slot = prism('_slot', [(-neck, 1), (neck, 1), (neck, -neck_depth), (wide, -neck_depth), (wide, -neck_depth - chamber),
                           (-wide, -neck_depth - chamber), (-wide, -neck_depth), (-neck, -neck_depth)],
                 2 * slot_half, (0, 0, 0), 'X', 'Y')
    _cut('tslot_rail', parent, place(slot, world))
    require_one_solid(parent, 'tslot_rail', 'The slot split the parent; make it thicker or wider around the slot.')

    _lift_child(child, world, clearance)
    # The head is the only part that touches the slot walls. The stem is shorter and has a looser fit, because a stem wall that
    # also crosses the shoulder makes the validator report a false penetration.
    stem = stem_width / 2
    head = wide - clearance
    top_of_head = -neck_depth - clearance
    slider = prism('_head', [(-head, top_of_head - head_height), (head, top_of_head - head_height), (head, top_of_head), (-head, top_of_head)],
                   length, (0, 0, 0), 'X', 'Y')
    join(slider, prism('_stem', [(-stem, top_of_head - 1), (stem, top_of_head - 1), (stem, 3 * clearance + 1), (-stem, 3 * clearance + 1)],
                       length - 2, (0, 0, 0), 'X', 'Y'))
    join(child, place(slider, world))
    require_one_solid(child, 'tslot_rail', 'The stem must overlap the child; make the child cover the slot at the pivot.')
    return joint(name or child.name + 'Slide', 'prismatic', parent, child, direction(axis), pivot,
                 limits if limits is not None else (-travel / 2, travel / 2), control)


def telescoping_tube(parent, child, pivot, axis, tube_diameter, travel=30, flange_thickness=4, lip=6, clearance=0.4,
                     neck_clearance=0.6, lock=4, stop_gap=0.4, limits=None, control=None, name=None):
    """An inner tube with a flange sliding inside a chamber in `parent`, stopped by a lip at the mouth and by the floor.

    pivot: the centre of the mouth on the parent's face. axis: out of the mouth, along the tube. The parent occupies the space behind
    the pivot, deep enough for travel + flange_thickness + lip + 2 mm of floor + 1.5 mm, and wide enough for the chamber (flange
    diameter + 2 * lock + 2 * clearance + 3 mm); the recipe cuts the chamber and the lip and leaves the floor. child: a solid rod of
    radius tube_diameter / 2 along the axis that reaches into the chamber at least that deep; the recipe cuts its end square and fuses
    on the flange. The flange is an oval, `lock` mm longer each way than a circle along local X, so the tube cannot spin.
    neck_clearance: the looser gap between the tube and the mouth; the flange sets the real fit. stop_gap: how far past `travel` the
    flange meets the lip and the floor; it stays under 0.5 mm because a vertical tube sags onto its lower stop. It prints in place.
    Returns the prismatic joint record; limits default to (-travel / 2, travel / 2). Positive moves the tube out.
    """
    world = frame(pivot, axis)
    tube = tube_diameter / 2
    mouth = tube + neck_clearance
    flange = mouth + 1.5
    chamber = flange + clearance
    z_flange_top = -lip - stop_gap - travel / 2
    z0 = z_flange_top - flange_thickness
    floor_top = z0 - travel / 2 - stop_gap
    _check_surface('telescoping_tube', parent, world)
    (x_low, x_high), (y_low, y_high), (z_low, _) = _extent(parent, world)
    needs = (-floor_top + 2, chamber + lock + 1.5, chamber + 1.5)
    if -z_low < needs[0] or min(-x_low, x_high) < needs[1] or min(-y_low, y_high) < needs[2]:
        raise ValueError('telescoping_tube: the parent must reach %.1f mm behind the pivot, %.1f mm sideways along local X and %.1f mm the other way; it reaches %.1f, %.1f and %.1f'
                         % (needs[0], needs[1], needs[2], -z_low, min(-x_low, x_high), min(-y_low, y_high)))
    (cx_low, cx_high), (cy_low, cy_high), (cz_low, _) = _extent(child, world)
    inverse = world.inverted()
    reach = max(math.hypot(*(inverse @ (vertex.co / MM))[:2]) for vertex in child.data.vertices)
    if reach > tube + 0.5:
        raise ValueError('telescoping_tube: the child is wider than tube_diameter %.1f (it reaches %.1f from the axis)' % (tube_diameter, reach))
    if cz_low > z0 + flange_thickness - 1:
        raise ValueError('telescoping_tube: the child must reach down to %.1f mm behind the pivot so the flange can be fused to it; it stops at %.1f' % (z0 + flange_thickness - 1, cz_low))

    cut(parent, place(cylinder('_mouth', mouth, lip + 3, (0, 0, -lip / 2 + 0.5), segments=96), world))
    _cut('telescoping_tube', parent, place(_stadium(chamber, lock, floor_top, -lip), world))
    require_one_solid(parent, 'telescoping_tube', 'The chamber split the parent; use a thicker parent around the tube.')
    cut(child, place(box2('_below', (-500, -500, -500), (500, 500, z0 + 1.3)), world))
    join(child, place(_stadium(flange, lock, z0, z0 + flange_thickness), world))
    require_one_solid(child, 'telescoping_tube', 'The child must reach down to the flange; lengthen it into the chamber.')
    return joint(name or child.name + 'Slide', 'prismatic', parent, child, direction(axis), pivot,
                 limits if limits is not None else (-travel / 2, travel / 2), control)


def pin_slot(parent, child, pivot, axis, up, travel=24, pin_diameter=4.5, pin_length=8, head_diameter=10, head_length=16, head_height=2,
             shoulder=3, clearance=0.35, neck_clearance=1.0, limits=None, control=None, name=None):
    """A headed pin on `child` running in a slot in `parent`. The slot is closed at both ends and the head is enclosed, so the pin never leaves.

    parent: a plate or block at the pivot, at least shoulder + head_height + 2 * clearance + 1.5 mm thick, head_diameter + 2 * clearance + 3 mm
    wide and travel + head_length + 4 mm long. child: a block above the slot, its underside trimmed to 3 * `clearance` above the
    parent; the pin comes down through the slot into a rounded chamber under a `shoulder` mm thick lid, where the head sits.
    The pin and head are long rounded ovals (pin_length, head_length along axis), not circles, so the block cannot swivel on the pin.
    neck_clearance: the looser gap round the pin; the head sets the real fit. It prints in place (print the parent upright; the lid
    bridges the chamber). Returns the prismatic joint record; limits default to (-travel / 2, travel / 2).
    """
    world = _frame('pin_slot', pivot, axis, up)
    pin = pin_diameter / 2
    head = head_diameter / 2
    chamber = head_height + 2 * clearance
    if head < pin + 1.5 or pin_length < pin_diameter or head_length < head_diameter:
        raise ValueError('pin_slot: head_diameter %.1f must be at least pin_diameter + 3, and each length at least its diameter' % head_diameter)
    reach = travel / 2 + _STOP_GAP - clearance
    pin_offset = pin_length / 2 - pin
    head_offset = head_length / 2 - head
    _check_surface('pin_slot', parent, world)
    (x_low, x_high), (y_low, y_high), (z_low, _) = _extent(parent, world)
    need = (shoulder + chamber + 1.5, head + clearance + 1.5, reach + head_offset + head + clearance + 1.5)
    if -z_low < need[0] or min(-y_low, y_high) < need[1] or min(-x_low, x_high) < need[2]:
        raise ValueError('pin_slot: the parent must reach %.1f mm below the pivot, %.1f mm either side of the slot and %.1f mm either way along it; it reaches %.1f, %.1f and %.1f'
                         % (need[0], need[1], need[2], -z_low, min(-y_low, y_high), min(-x_low, x_high)))
    (_, top) = _extent(child, world)[2]
    if top < 3 * clearance + 3:
        raise ValueError('pin_slot: the child must reach at least %.1f mm above the parent surface' % (3 * clearance + 3))

    _cut('pin_slot', parent, place(_stadium(pin + neck_clearance, reach + pin_offset, -shoulder - 1, 1), world))
    _cut('pin_slot', parent, place(_stadium(head + clearance, reach + head_offset, -shoulder - chamber, -shoulder), world))
    require_one_solid(parent, 'pin_slot', 'The slot split the parent; make it thicker or wider around the slot.')

    _lift_child(child, world, clearance)
    top_of_head = -shoulder - clearance
    stem = _stadium(pin, pin_offset, top_of_head - 1, 3 * clearance + 1)
    join(stem, _stadium(head, head_offset, top_of_head - head_height, top_of_head))
    join(child, place(stem, world))
    require_one_solid(child, 'pin_slot', 'The pin must overlap the child; make the child cover the pivot.')
    return joint(name or child.name + 'Slide', 'prismatic', parent, child, direction(axis), pivot,
                 limits if limits is not None else (-travel / 2, travel / 2), control)
